// Ibovespa, dólar e histórico pro gráfico (precisa do token grátis da brapi em BRAPI_TOKEN).
//   site/mercado.json          { atualizadoEm, ibov, ifix, dolar: [valor, var %] | null }        (toda rodada)
//   site/historico/TICKER.json [[data, abertura, máxima, mínima, fechamento], ...]               (uma vez por dia)
// O plano grátis da brapi dá 3 meses de histórico diário e um ativo por consulta: o histórico sai só
// pros ativos mais negociados, dentro do limite de 15.000 consultas por mês.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

const TOKEN = process.env.BRAPI_TOKEN;
const QUANTOS = 250; // ativos com histórico (os mais negociados)
const SEMPRE = ['PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'BBDC4', 'ABEV3', 'SANB11', 'WEGE3', 'BBSE3', 'ITSA4', 'TAEE11', 'EGIE3',
  'MXRF11', 'HGLG11', 'XPML11', 'KNRI11', 'BTLG11', 'VISC11', 'KNCA11', 'SNAG11', 'RZTR11', 'CPTS11', 'CPTR11'];

if (!TOKEN) { console.log('sem BRAPI_TOKEN: pulei Ibovespa, dólar e histórico'); process.exit(0); }

async function brapi(caminho) {
  const sep = caminho.includes('?') ? '&' : '?';
  let status = 0;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const r = await fetch(`https://brapi.dev/api/${caminho}${sep}token=${TOKEN}`);
    if (r.ok) return r.json();
    status = r.status;
    if (r.status === 404 || r.status === 400 || r.status === 401 || r.status === 403) break;
    await new Promise((ok) => setTimeout(ok, 4000 * tentativa));
  }
  console.log(`brapi ${caminho.split('?')[0]}: ${status}`);
  return null;
}

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- Ibovespa, IFIX e dólar (toda rodada) ----------
// o dólar vem da AwesomeAPI (grátis, sem chave): o plano grátis da brapi não tem moedas
async function dolar() {
  try {
    const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
    const d = (await r.json()).USDBRL;
    return [Number(d.bid), Math.round(Number(d.pctChange || 0) * 100) / 100];
  } catch { console.log('dólar: falhou'); return null; }
}
const indice = (j) => { const x = j?.results?.[0]; return x ? [x.regularMarketPrice, Math.round((x.regularMarketChangePercent || 0) * 100) / 100] : null; };
const [ib, ifx, us] = await Promise.all([brapi('quote/%5EBVSP'), brapi('quote/IFIX'), dolar()]);
mkdirSync('site/historico', { recursive: true });
const mercado = { atualizadoEm: new Date().toISOString(), ibov: indice(ib), ifix: indice(ifx), dolar: us };
if (!mercado.ibov) throw new Error('o Ibovespa não veio da brapi');
writeFileSync('site/mercado.json', JSON.stringify(mercado));

// ---------- histórico (uma vez por dia, na primeira rodada depois das 18h30) ----------
// os arquivos de ontem voltam do cache do GitHub; indice.json diz de que dia eles são
const agora = new Date();
const minutosBR = ((agora.getUTCHours() + 21) % 24) * 60 + agora.getUTCMinutes();
const ultimo = existsSync('site/historico/indice.json') ? JSON.parse(readFileSync('site/historico/indice.json', 'utf8')).atualizadoEm : '';
const jaFeito = ultimo && diaBR(new Date(ultimo)) === diaBR(agora);
const forcar = process.env.HISTORICO === '1' || !ultimo;
if (!forcar && (jaFeito || minutosBR < 18 * 60 + 30)) { console.log('ok: Ibovespa e dólar'); process.exit(0); }

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const porVolume = Object.keys(cat).sort((a, b) => cat[b][4] - cat[a][4]);
const lista = [...new Set(['^BVSP', ...SEMPRE.filter((t) => cat[t]), ...porVolume])].slice(0, QUANTOS + 1);

let feitos = 0;
for (const tk of lista) {
  const j = await brapi(`quote/${encodeURIComponent(tk)}?range=3mo&interval=1d`);
  const h = j?.results?.[0]?.historicalDataPrice || [];
  const velas = h
    .filter((v) => v.close > 0)
    .map((v) => [v.date, v.open, v.high, v.low, v.close]);
  if (velas.length) {
    writeFileSync(`site/historico/${tk === '^BVSP' ? 'IBOV' : tk}.json`, JSON.stringify(velas));
    feitos++;
  }
  await espera(250); // sem pressa: não estoura o limite por minuto
}
writeFileSync('site/historico/indice.json', JSON.stringify({ atualizadoEm: new Date().toISOString(), tickers: lista.map((t) => (t === '^BVSP' ? 'IBOV' : t)) }));
writeFileSync('.historico-novo', '1'); // avisa o robô pra guardar no cache
console.log(`ok: Ibovespa, dólar e histórico de ${feitos} ativos`);
