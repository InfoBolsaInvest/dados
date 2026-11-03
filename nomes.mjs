// Nomes de ativos que a brapi manda só com o ticker (quase todos BDRs, ex.: ROXO34 = Nubank).
// Busca no Yahoo Finanças (grátis) e guarda em nomes.json (no repositório) ou, no robô, em
// site/longo/nomes-novos.json (cache do Actions) só para os tickers que ainda não têm nome.
// Uso: node nomes.mjs [arquivo de saída]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAIDA = process.argv[2] || 'nomes.json';
const ler = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const conhecidos = { ...ler('nomes.json'), ...ler('site/longo/nomes-novos.json') };
const saida = ler(SAIDA);
const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const faltam = Object.keys(cat).filter((tk) => cat[tk][0] === tk && !conhecidos[tk]);
console.log(`sem nome: ${faltam.length}`);

const MINUSC = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'of', 'and', 'the']);
function arrumar(nome) {
  let n = nome
    .replace(/\s+/g, ' ')
    .replace(/\s*-?\s*FUNDO DE [ÍI]NDICE.*$/i, '')
    .replace(/\s+RESPONSABILIDADE LIMITADA.*$/i, '')
    .replace(/fundo de investimento em cotas de fundos? de investimento em direitos credit[óo]rios/i, 'FIC FIDC')
    .replace(/fundo de investimento em direitos credit[óo]rios/i, 'FIDC')
    .replace(/fundo de investimento imobili[áa]rio/i, 'FII')
    .replace(/fundo de investimento nas cadeias produtivas agroindustriais/i, 'Fiagro')
    .replace(/\s+(resp(onsabilidade)?\.? limitada|classe de [íi]ndice)\b.*$/i, '')
    .replace(/,?\s+(Inc|Ltd|Limited|Corporation|Corp|Co|plc|PLC|N\.?V|S\.?A|SE|AG|L\.?P)\.?$/i, '')
    .replace(/,?\s+(Inc|Ltd|Corp)\.?$/i, '')
    .replace(/\s+[A-Z]{3}\/$/, '')
    .replace(/\s+-?CI\b.*$/, '')
    .replace(/[\s\-/*]+$/, '')
    .trim();
  // tudo maiúsculo vira "Assim Mesmo", mantendo siglas curtas
  if (n === n.toUpperCase() && /[A-Z]{4,}/.test(n)) {
    n = n.toLowerCase().split(' ').map((p, i) => (i && MINUSC.has(p) ? p : p.length <= 3 && !/[aeiou]/.test(p) ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' ');
  }
  // "Fundo De Investimento" vira "Fundo de Investimento"
  return n.split(' ').map((p, i) => (i && MINUSC.has(p.toLowerCase()) ? p.toLowerCase() : p)).join(' ');
}

async function nomeDe(tk) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${tk}.SA?range=1d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  const bruto = m?.longName || (m?.shortName || '').replace(/\s+(DRN|DR\d|CI|F11|ON|PN|UNT)\b.*$/i, '').trim();
  return bruto && bruto.toUpperCase() !== tk ? arrumar(bruto) : null;
}

let achados = 0;
for (const tk of faltam) {
  try {
    const n = await nomeDe(tk);
    if (n) { saida[tk] = n; achados++; }
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
mkdirSync(dirname(SAIDA), { recursive: true });
writeFileSync(SAIDA, JSON.stringify(saida, null, 0).replace(/","/g, '",\n"'));
if (achados && SAIDA.startsWith('site/')) writeFileSync('.historico-novo', ''); // avisa o robô pra guardar o cache
console.log(`achados: ${achados}, gravado em ${SAIDA}`);
