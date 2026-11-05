import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } from '@discordjs/voice';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const FILE = './sesiones.json';
const pool = new Map();
const grp = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);

const guardar = () => {
  const out = [...pool.values()].filter((e) => e.cfg?.channelId)
    .map((e) => ({ token: e.token, cfg: e.cfg }));
  try { fs.writeFileSync(FILE, JSON.stringify(out, null, 2)); } catch (e) { console.error(e.message); }
};

async function getClient(token) {
  const hit = pool.get(token);
  if (hit) return hit.client;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.on('error', (e) => console.error('WS:', e.message));
  client.on('shardError', (e) => console.error('SHARD:', e.message));
  pool.set(token, { token, client, cfg: {}, group: grp(token) });
  try { await client.login(token); } catch (e) { pool.delete(token); throw e; }
  if (!client.isReady()) await new Promise((r) => client.once(Events.ClientReady, r));
  return client;
}

async function conectar(token, guildId, channelId, selfMute, selfDeaf) {
  const client = await getClient(token);
  const ch = await client.channels.fetch(channelId);
  const guild = ch?.guild ?? client.guilds.cache.get(guildId);
  if (!guild) throw new Error('no encuentro el servidor');
  const g = pool.get(token).group;
  getVoiceConnection(guild.id, g)?.destroy();
  const conn = joinVoiceChannel({
    channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
    selfMute: !!selfMute, selfDeaf: !!selfDeaf, group: g,
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      conn.rejoin();
    } catch {
      const c = pool.get(token)?.cfg;
      try { conn.destroy(); } catch {}
      if (c?.channelId) setTimeout(() => conectar(token, c.guildId, c.channelId, c.selfMute, c.selfDeaf).catch(() => {}), 5_000);
    }
  });
  pool.get(token).cfg = { guildId: guild.id, channelId: ch.id, selfMute: !!selfMute, selfDeaf: !!selfDeaf };
  guardar();
  return { canal: ch.name, servidor: guild.name };
}

app.get('/api/health', (_q, r) => r.json({ ok: true, sesiones: pool.size }));

app.post('/api/resolve', async (req, res) => {
  const code = String(req.body.invite || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!code) return res.status(400).send('enlace vacío');
  try {
    const r2 = await fetch(`https://discord.com/api/v10/invites/${code}?with_counts=true`);
    const j = await r2.json();
    if (!r2.ok) return res.status(404).send(j.message || 'invitación inválida');
    res.json({ guildId: j.guild.id, guildName: j.guild.name, channelId: j.channel.id, channelName: j.channel.name });
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/join', async (req, res) => {
  const { token, guildId, channelId, selfMute = true, selfDeaf = false } = req.body;
  if (!token || !channelId) return res.status(400).send('faltan token o canal');
  try { res.json({ ok: true, ...(await conectar(token, guildId, channelId, selfMute, selfDeaf)) }); }
  catch (e) { res.status(500).send(e.message); }
});

app.post('/api/state', async (req, res) => {
  const { token, selfMute, selfDeaf } = req.body;
  const hit = pool.get(token);
  if (!hit?.cfg?.channelId) return res.status(409).send('no está conectado');
  try { await conectar(token, hit.cfg.guildId, hit.cfg.channelId, selfMute, selfDeaf); res.json({ ok: true }); }
  catch (e) { res.status(500).send(e.message); }
});

app.post('/api/leave', async (req, res) => {
  const hit = pool.get(req.body.token);
  if (hit) {
    if (hit.cfg.guildId) { try { getVoiceConnection(hit.cfg.guildId, hit.group)?.destroy(); } catch {} }
    try { hit.client.destroy(); } catch {}
    pool.delete(req.body.token);
    guardar();
  }
  res.json({ ok: true });
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log('LISTO'));

for (const s of (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })()) {
  setTimeout(() => conectar(s.token, s.cfg.guildId, s.cfg.channelId, s.cfg.selfMute, s.cfg.selfDeaf)
    .then(() => console.log('reconectado'))
    .catch((e) => console.log('falló:', e.message)), 3_000);
}