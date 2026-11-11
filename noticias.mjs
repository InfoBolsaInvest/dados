// Notícias reais (só manchete, fonte, hora e link; o texto fica no site de quem publicou):
//   toda rodada: feeds públicos de portais de investimento
//   uma vez por dia: Google Notícias por ticker, pros ativos mais negociados
// Junta com o que já está publicado e guarda 7 dias. Gera site/noticias.json [{ d, h, f, ti, u, t: [tickers] }]
import { readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const UA = { 'User-Agent': 'Mozilla/5.0' };
// (o de mercados do InfoMoney vinha vazio: saiu em 10/11/2026; Poder360 e IstoÉ Dinheiro não têm feed que funcione)
const FEEDS = [
  ['InfoMoney', 'https://www.infomoney.com.br/feed/'],
  ['Money Times', 'https://www.moneytimes.com.br/feed/'],
  ['E-Investidor', 'https://einvestidor.estadao.com.br/feed/'],
  ['Suno', 'https://www.suno.com.br/noticias/feed/'],
  ['FIIs', 'https://fiis.com.br/feed/'],
  ['G1', 'https://g1.globo.com/rss/g1/economia/'],
  ['Folha', 'https://feeds.folha.uol.com.br/mercado/rss091.xml'],
  ['InvestNews', 'https://investnews.com.br/feed/'],
  ['Exame', 'https://exame.com/feed/'],
  ['Estadão', 'https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/sections/economia/'],
  ['Seu Dinheiro', 'https://www.seudinheiro.com/feed/'],
  ['Investing.com', 'https://br.investing.com/rss/news.rss'],
  ['Agência Brasil', 'https://agenciabrasil.ebc.com.br/rss/economia/feed.xml'],
  ['Brazil Journal', 'https://braziljournal.com/feed/'],
  ['BP Money', 'https://bpmoney.com.br/feed/'],
];
// Google Notícias por tema, de hora em hora: pega o que sai em portais sem feed (Valor, CNN, Bloomberg Línea...)
const TEMAS = ['Ibovespa', 'bolsa de valores', 'mercado financeiro', 'economia brasileira', 'Selic juros', 'Copom', 'Banco Central',
  'inflação IPCA', 'dólar câmbio', 'dividendos', 'fundos imobiliários', 'tributação investimentos', 'Wall Street', 'Tesouro Direto'];
const POR_TEMA = 10;
// páginas de cotação que o Google Notícias às vezes mistura com notícia
// seções dos portais que não são de mercado (o feed geral do InfoMoney traz esporte, saúde e carreira: apareceu o grid
// da Fórmula 1 nas notícias do app). Vale também para o que já estava publicado
const FORA_DO_ASSUNTO = /^https?:\/\/[^/]+\/(esportes?|futebol|saude|ciencia-e-saude|bem-estar|carreira|consumo|entretenimento|cultura|lifestyle|pop|pop-arte|casual|celebridades|famosos|horoscopo|receitas|viagem|turismo|games|moda|estilo)\//i;
// pela manchete: esporte, novela, reality e afins ficam de fora, a não ser que falem de dinheiro investido
// (ex.: o Barsi comprando parte de um time, a SAF de um clube, a ação de uma empresa de apostas)
const ASSUNTO_FORA = /\b(futebol|campeonato|brasileir[ãa]o|libertadores|copa do mundo|gols?|escala[çc][ãa]o|t[ée]cnico do|f[óo]rmula 1|grid de largada|gp d[eo]|nba|nfl|ufc|t[êe]nis|v[ôo]lei|olimp[ií]ada|bbb|big brother|novela|reality|hor[óo]scopo|signo)\b/i;
const DE_INVESTIMENTO = /\b(invest\w*|a[çc][õo]es|bolsa|b3|dividend\w*|ipo|saf|acionista\w*|balan[çc]o|lucro|d[íi]vida|recupera[çc][ãa]o judicial|barsi|valuation|fundo)\b/i;
// rede social não é notícia (o Google Notícias às vezes traz post de Instagram)
const REDE_SOCIAL = /^(instagram|facebook|youtube|tiktok|x|twitter|threads|linkedin)$/i;
const foraDoAssunto = (n) => REDE_SOCIAL.test(n.f) || FORA_DO_ASSUNTO.test(n.u || '') || (ASSUNTO_FORA.test(n.ti) && !DE_INVESTIMENTO.test(n.ti) && !n.t.length);
// páginas de cotação e resultado de loteria (os portais publicam no mesmo feed) não são notícia de mercado
const NAO_E_NOTICIA = /hist[óo]rico de pre[çc]os|^cota[çc][ãa]o|cota[çc][ãa]o (hoje|em tempo real|e indicadores)|^gr[áa]fico|\b(mega-?sena|quina|lotof[áa]cil|lotomania|timemania|dupla sena|dia de sorte|super sete|\+milion[áa]ria|loteria federal)\b.*(concurso|resultado|sorteio|pr[êe]mio)/i;
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
let ultimaTemas = '';
try {
  const r = await fetch(`${SITE}/noticias.json?x=${Date.now()}`);
  if (r.ok) { const j = await r.json(); publicadas = j.n || []; ultimaBusca = j.buscaPorTicker || ''; ultimaTemas = j.buscaTemas || ''; }
} catch {}

const novas = [];
for (const [fonte, url] of FEEDS) {
  try {
    // a Folha manda em ISO-8859-1: lê no código que o próprio arquivo declara (senão os acentos viram "�")
    const buf = await (await fetch(url, { headers: UA })).arrayBuffer();
    const cod = (new TextDecoder('latin1').decode(buf.slice(0, 300)).match(/encoding=["']([\w-]+)["']/i)?.[1] || 'utf-8').toLowerCase();
    const xml = new TextDecoder(cod === 'iso-8859-1' ? 'latin1' : cod).decode(buf);
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
        if (!it || NAO_E_NOTICIA.test(it.ti)) continue;
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

// Google Notícias por tema: de hora em hora (a chave é dia e hora de Brasília)
const horaAgora = brt(agora).toISOString().slice(0, 13);
if (ultimaTemas !== horaAgora) {
  let n = 0;
  for (const tema of TEMAS) {
    try {
      const xml = await (await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(tema)}+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419`, { headers: UA })).text();
      for (const x of itens(xml).slice(0, POR_TEMA)) {
        const fonte = texto(x.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]) || 'Google Notícias';
        const it = item(fonte, x);
        if (!it || NAO_E_NOTICIA.test(it.ti)) continue;
        it.ti = it.ti.replace(new RegExp(`\\s+-\\s+${fonte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); // tira " - Fonte" do fim
        novas.push(it);
        n++;
      }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 400));
  }
  ultimaTemas = horaAgora;
  console.log(`Google Notícias por tema: ${n} manchetes`);
}

// junta, tira repetidas (mesma manchete) e guarda 7 dias
const chave = (n) => n.ti.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const porChave = new Map();
for (const n of [...novas, ...publicadas]) {
  if (n.d < corte || NAO_E_NOTICIA.test(n.ti) || foraDoAssunto(n)) continue;
  const k = chave(n);
  const ja = porChave.get(k);
  if (ja) { ja.t = [...new Set([...ja.t, ...n.t])]; continue; }
  porChave.set(k, n);
}
// manchete quase igual da mesma fonte no mesmo dia (o site só trocou uma palavra: "caíram" → "caem"): fica a
// mais nova, com os tickers das duas. Parecida = 75% ou mais das palavras em comum.
const palavras = (ti) => new Set(ti.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const parecida = (a, b) => {
  const pa = palavras(a.ti), pb = palavras(b.ti);
  let comum = 0;
  for (const w of pa) if (pb.has(w)) comum++;
  return comum / Math.max(1, Math.min(pa.size, pb.size)) >= 0.75 && comum >= 4;
};
const ordenadas = [...porChave.values()].sort((a, b) => (a.d + a.h.padStart(5, '0') < b.d + b.h.padStart(5, '0') ? 1 : -1));
const unicas = [];
for (const n of ordenadas) {
  const igual = unicas.find((u) => u.f === n.f && u.d === n.d && parecida(u, n));
  if (igual) { igual.t = [...new Set([...igual.t, ...n.t])]; continue; }
  unicas.push(n);
}
const lista = unicas.slice(0, 3000); // com as fontes novas passa de 300 por dia: 3.000 cobre a semana
writeFileSync('site/noticias.json', JSON.stringify({ atualizadoEm: agora.toISOString(), buscaPorTicker: ultimaBusca, buscaTemas: ultimaTemas, n: lista }));
console.log(`ok: ${lista.length} notícias (${novas.length} lidas agora)`);
