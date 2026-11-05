import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } from '@discordjs/voice';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Map(); // token -> { client, cfg }

async function getClient(token) {
  const hit = pool.get(token);
  if (hit) return hit.client;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel],
  });
  await client.login(token);
  if (!client.isReady()) await new Promise((r) => client.once('ready', r));
  pool.set(token, { client, cfg: {} });
  return client;
}

app.get('/api/health', (_q, r) => r.json({ ok: true, sesiones: pool.size }));

// resuelve un enlace de invitación sin necesidad de token
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
  try {
    if (!token || !channelId) return res.status(400).send('faltan token o canal');
    const client = await getClient(token);
    const ch = await client.channels.fetch(channelId);
    const guild = ch?.guild ?? client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).send('no encuentro el servidor');

    getVoiceConnection(guild.id)?.destroy();
    const conn = joinVoiceChannel({
      channelId: ch.id, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: !!selfMute, selfDeaf: !!selfDeaf,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    conn.on(VoiceConnectionStatus.Disconnected, () => { try { conn.rejoin(); } catch {} });

    pool.get(token).cfg = { guildId: guild.id, channelId: ch.id, selfMute: !!selfMute, selfDeaf: !!selfDeaf };
    res.json({ ok: true, canal: ch.name, servidor: guild.name });
  } catch (e) { res.status(500).send(e.message); }
});

// mute / sordera: reconecta con el nuevo estado
app.post('/api/state', async (req, res) => {
  const { token, selfMute, selfDeaf } = req.body;
  const hit = pool.get(token);
  if (!hit?.cfg?.channelId) return res.status(409).send('no está conectado');
  try {
    const guild = hit.client.guilds.cache.get(hit.cfg.guildId);
    getVoiceConnection(hit.cfg.guildId)?.destroy();
    const conn = joinVoiceChannel({
      channelId: hit.cfg.channelId, guildId: hit.cfg.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: !!selfMute, selfDeaf: !!selfDeaf,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    hit.cfg.selfMute = !!selfMute; hit.cfg.selfDeaf = !!selfDeaf;
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/leave', async (req, res) => {
  const hit = pool.get(req.body.token);
  if (hit) {
    if (hit.cfg.guildId) getVoiceConnection(hit.cfg.guildId)?.destroy();
    hit.client.destroy();
    pool.delete(req.body.token);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('LISTO -> puerto ' + PORT));
