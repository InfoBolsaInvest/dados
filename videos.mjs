// Vídeos do canal da InfoBolsa no YouTube (toda rodada, uma consulta só): o feed público do canal traz os
// 15 mais recentes com título, data e visualizações. Junta com a lista já publicada (e com videos-base.json),
// então os antigos continuam. Shorts ficam de fora. Gera site/videos.json [{ id, t, d, s, v }]
import { readFileSync, writeFileSync } from 'node:fs';

const CANAL = 'UCbCUEAgLS__JWgcyxy7y63A';
const SITE = 'https://infobolsainvest.github.io/dados';
const UA = { 'User-Agent': 'Mozilla/5.0' };

let lista = JSON.parse(readFileSync('videos-base.json', 'utf8'));
try {
  const r = await fetch(`${SITE}/videos.json?x=${Date.now()}`);
  if (r.ok) { const pub = await r.json(); if (pub.length) lista = pub; }
} catch {}
const porId = new Map(lista.map((v) => [v.id, v]));

// o feed às vezes responde erro: segue só com a atualização dos antigos
let xml = '';
try { const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CANAL}`, { headers: UA }); if (r.ok) xml = await r.text(); } catch {}
const texto = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
let novos = 0;
for (const e of xml.split('<entry>').slice(1)) {
  const id = e.match(/<yt:videoId>([^<]+)/)?.[1];
  const t = texto(e.match(/<media:title>([^<]*)/)?.[1] || '');
  const d = (e.match(/<published>([^<]+)/)?.[1] || '').slice(0, 10);
  const v = Number(e.match(/views="(\d+)"/)?.[1] || 0);
  if (!id || /#shorts?\b/i.test(t)) continue;
  const antigo = porId.get(id);
  if (antigo) { antigo.t = t; antigo.v = Math.max(v, antigo.v || 0); continue; }
  // duração: só pra vídeo novo, na página do próprio vídeo
  let s = 0;
  try {
    const p = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { ...UA, 'Accept-Language': 'pt-BR' } })).text();
    s = Number(p.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0);
  } catch {}
  if (s && s <= 60) continue; // short sem a hashtag no título
  porId.set(id, { id, t, d, s, v });
  novos++;
}
// visualizações e duração de todos: a cada rodada, os 4 vídeos atualizados há mais tempo (a = quando)
const fila = [...porId.values()].sort((a, b) => (a.a || 0) - (b.a || 0)).slice(0, 4);
for (const v of fila) {
  try {
    const p = await (await fetch(`https://www.youtube.com/watch?v=${v.id}`, { headers: { ...UA, 'Accept-Language': 'pt-BR' } })).text();
    const vistos = Number(p.match(/"viewCount":"(\d+)"/)?.[1] || 0);
    const dur = Number(p.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0);
    if (vistos) v.v = vistos;
    if (dur) v.s = dur;
    if (vistos || dur) v.a = Date.now();
  } catch {}
}
const saida = [...porId.values()].sort((a, b) => (a.d < b.d ? 1 : -1));
writeFileSync('site/videos.json', JSON.stringify(saida));
console.log(`ok: ${saida.length} vídeos (${novos} novos)`);
