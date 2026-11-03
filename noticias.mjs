// Notícias reais (só manchete, fonte, hora e link; o texto fica no site de quem publicou):
//   toda rodada: feeds públicos de portais de investimento
//   uma vez por dia: Google Notícias por ticker, pros ativos mais negociados
// Junta com o que já está publicado e guarda 7 dias. Gera site/noticias.json [{ d, h, f, ti, u, t: [tickers] }]
import { readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const FEEDS = [
  ['InfoMoney', 'https://www.infomoney.com.br/feed/'],
  ['InfoMoney', 'https://www.infomoney.com.br/mercados/feed/'],
  ['Money Times', 'https://www.moneytimes.com.br/feed/'],
  ['E-Investidor', 'https://einvestidor.estadao.com.br/feed/'],
  ['Suno', 'https://www.suno.com.br/noticias/feed/'],
  ['FIIs', 'https://fiis.com.br/feed/'],
];
const POR_TICKER = 120; // ativos com busca própria no Google Notícias (os mais negociados)
const DIAS = 7;
// nomes que aparecem na manchete sem o ticker
const NOMES = {
  'Petrobras': ['PETR4', 'PETR3'], 'Itaú': ['ITUB4'], 'Bradesco': ['BBDC4'], 'Banco do Brasil': ['BBAS3'], 'Ambev': ['ABEV3'],
  'WEG': ['WEGE3'], 'Magazine Luiza': ['MGLU3'], 'Magalu': ['MGLU3'], 'Eletrobras': ['AXIA3'], 'Axia': ['AXIA3'], 'Sabesp': ['SBSP3'],
  'Suzano': ['SUZB3'], 'Gerdau': ['GGBR4'], 'JBS': ['JBSS32'], 'Embraer': ['EMBJ3'], 'Localiza': ['RENT3'], "Rede D'Or": ['RDOR3'],
  'Raízen': ['RAIZ4'], 'Cosan': ['CSAN3'], 'Copel': ['CPLE3'], 'Cemig': ['CMIG4'], 'Natura': ['NATU3'], 'Hapvida': ['HAPV3'],
  'Rumo': ['RAIL3'], 'Klabin': ['KLBN11'], 'Santander': ['SANB11'], 'BTG Pactual': ['BPAC11'], 'Nubank': ['ROXO34'],
  'Casas Bahia': ['BHIA3'], 'Americanas': ['AMER3'], 'Usiminas': ['USIM5'], 'CSN': ['CSNA3'], 'Vibra': ['VBBR3'], 'Prio': ['PRIO3'],
  'PetroRio': ['PRIO3'], 'Telefônica': ['VIVT3'], 'Totvs': ['TOTS3'], 'Renner': ['LREN3'], 'Assaí': ['ASAI3'], 'Marfrig': ['MBRF3'],
  'MBRF': ['MBRF3'], 'Minerva': ['BEEF3'], 'Motiva': ['MOTV3'], 'Equatorial': ['EQTL3'], 'Taesa': ['TAEE11'], 'Engie': ['EGIE3'],
  'BB Seguridade': ['BBSE3'], 'Itaúsa': ['ITSA4'], 'Cielo': [], 'Braskem': ['BRKM5'], 'Ultrapar': ['UGPA3'], 'Caixa Seguridade': ['CXSE3'],
  'Mercado Livre': ['MELI34'], 'Vale': ['VALE3'], 'Apple': ['AAPL34'], 'Nvidia': ['NVDC34'], 'Microsoft': ['MSFT34'], 'Tesla': ['TSLA34'],
  'Amazon': ['AMZO34'], 'Alphabet': ['GOGL34'], 'Netflix': ['NFLX34'], 'Palantir': ['P2LT34'], 'Berkshire': ['BERK34'],
};

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const agora = new Date();
const brt = (d) => new Date(d.getTime() - 3 * 3600 * 1000);
const corte = brt(new Date(agora.getTime() - DIAS * 86400 * 1000)).toISOString().slice(0, 10);
const texto = (s) => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#8217;|&#8216;|&#39;|&apos;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function marcar(titulo) {
  const t = new Set();
  for (const m of titulo.match(/\b[A-Z]{4}\d{1,2}\b/g) || []) if (cat[m]) t.add(m);
  for (const [nome, tks] of Object.entries(NOMES)) {
    // "Vale" só quando não é o verbo ("vale a pena", "Vale lembrar")
    const re = nome === 'Vale' ? /\bVale\b(?!\s+(a|o|lembrar|ressaltar|destacar|dizer|notar|mais|menos|tudo|quanto|pena)\b)/ : new RegExp(`(^|[^\\p{L}])${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u');
    if (re.test(titulo)) tks.filter((x) => cat[x]).forEach((x) => t.add(x));
  }
  return [...t];
}
function item(fonte, x, extra = []) {
  const ti = texto(x.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
  const u = texto(x.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
  const quando = new Date(texto(x.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]));
  if (!ti || !u || isNaN(quando)) return null;
  const b = brt(quando);
  return { d: b.toISOString().slice(0, 10), h: `${b.getUTCHours()}h${String(b.getUTCMinutes()).padStart(2, '0')}`, f: fonte, ti, u, t: [...new Set([...marcar(ti), ...extra])] };
}
const itens = (xml) => xml.split('<item>').slice(1);

let publicadas = [];
let ultimaBusca = '';
try {
  const r = await fetch(`${SITE}/noticias.json?x=${Date.now()}`);
  if (r.ok) { const j = await r.json(); publicadas = j.n || []; ultimaBusca = j.buscaPorTicker || ''; }
} catch {}

const novas = [];
for (const [fonte, url] of FEEDS) {
  try {
    const xml = await (await fetch(url, { headers: UA })).text();
    for (const x of itens(xml)) { const n = item(fonte, x); if (n) novas.push(n); }
  } catch (e) { console.log(`${fonte}: ${e.message}`); }
}

// Google Notícias por ticker: uma vez por dia
const hoje = brt(agora).toISOString().slice(0, 10);
if (ultimaBusca !== hoje) {
  const top = Object.keys(cat).filter((tk) => ['acao', 'fii', 'fiagro'].includes(cat[tk][1])).sort((a, b) => (cat[b][4] || 0) - (cat[a][4] || 0)).slice(0, POR_TICKER);
  let n = 0;
  for (const tk of top) {
    try {
      const xml = await (await fetch(`https://news.google.com/rss/search?q=${tk}+when:7d&hl=pt-BR&gl=BR&ceid=BR:pt-419`, { headers: UA })).text();
      for (const x of itens(xml).slice(0, 6)) {
        const fonte = texto(x.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]) || 'Google Notícias';
        const it = item(fonte, x, [tk]);
        if (!it) continue;
        it.ti = it.ti.replace(new RegExp(`\\s+-\\s+${fonte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); // tira " - Fonte" do fim
        novas.push(it);
        n++;
      }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 400));
  }
  ultimaBusca = hoje;
  console.log(`Google Notícias: ${n} manchetes de ${top.length} ativos`);
}

// junta, tira repetidas (mesma manchete) e guarda 7 dias
const chave = (n) => n.ti.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const porChave = new Map();
for (const n of [...novas, ...publicadas]) {
  if (n.d < corte) continue;
  const k = chave(n);
  const ja = porChave.get(k);
  if (ja) { ja.t = [...new Set([...ja.t, ...n.t])]; continue; }
  porChave.set(k, n);
}
const lista = [...porChave.values()].sort((a, b) => (a.d + a.h.padStart(5, '0') < b.d + b.h.padStart(5, '0') ? 1 : -1)).slice(0, 1500);
writeFileSync('site/noticias.json', JSON.stringify({ atualizadoEm: agora.toISOString(), buscaPorTicker: ultimaBusca, n: lista }));
console.log(`ok: ${lista.length} notícias (${novas.length} lidas agora)`);
