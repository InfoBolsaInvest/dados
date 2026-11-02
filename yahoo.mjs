// Dados do Yahoo Finanças (grátis, sem chave) pro que o plano grátis da brapi não cobre:
//   - dólar, euro e bolsas de fora: valor e variação do dia (toda rodada) → entram em site/mercado.json
//   - histórico diário de 3 meses dessas bolsas e moedas (uma vez por dia) → site/historico/ID.json
//   - histórico semanal de 5 anos do Ibovespa, das moedas, das bolsas de fora e das ações (uma vez por semana) → site/longo/ID.json
// Datas já saem como aaaa-mm-dd no fuso de cada bolsa: [data, abertura, máxima, mínima, fechamento]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// id no app → símbolo no Yahoo
export const MUNDO = {
  USD: 'BRL=X', EUR: 'EURBRL=X',
  SPX: '^GSPC', NASDAQ: '^IXIC', DOW: '^DJI', NIKKEI: '^N225', DAX: '^GDAXI', FTSE: '^FTSE', HANGSENG: '^HSI', XANGAI: '000001.SS',
};
const UA = { 'user-agent': 'Mozilla/5.0 (InfoBolsa dados)' };
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function grafico(simbolo, range, interval) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=${range}&interval=${interval}`, { headers: UA });
      if (r.status === 404) return null;
      if (r.ok) return (await r.json())?.chart?.result?.[0] || null;
    } catch {}
    await espera(3000 * tentativa);
  }
  console.log(`yahoo ${simbolo} ${range}: falhou`);
  return null;
}

function velas(res) {
  const t = res?.timestamp || [];
  const q = res?.indicators?.quote?.[0] || {};
  const off = (res?.meta?.gmtoffset || 0) * 1000;
  const out = [];
  t.forEach((s, i) => {
    const c = q.close?.[i];
    if (!(c > 0)) return;
    const dia = new Date(s * 1000 + off).toISOString().slice(0, 10);
    const r2 = (x) => Math.round((x || c) * 10000) / 10000;
    const v = [dia, r2(q.open?.[i]), r2(q.high?.[i]), r2(q.low?.[i]), r2(c)];
    if (out.length && out[out.length - 1][0] === dia) out[out.length - 1] = v; else out.push(v);
  });
  return out;
}

mkdirSync('site/historico', { recursive: true });
mkdirSync('site/longo', { recursive: true });

// ---------- valor e variação do dia (toda rodada) ----------
const mundo = {};
for (const [id, s] of Object.entries(MUNDO)) {
  const res = await grafico(s, '5d', '1d');
  const v = velas(res);
  const preco = res?.meta?.regularMarketPrice;
  const ant = v.length >= 2 ? v[v.length - 2][4] : null;
  if (preco > 0 && ant > 0) mundo[id] = [preco, Math.round((preco / ant - 1) * 10000) / 100];
  await espera(200);
}
const arq = 'site/mercado.json';
const mercado = existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : { atualizadoEm: new Date().toISOString() };
mercado.mundo = mundo;
if (mundo.USD) mercado.dolar = mundo.USD; // o dólar do Yahoo traz a variação certa
writeFileSync(arq, JSON.stringify(mercado));

// ---------- 3 meses diários das bolsas de fora e moedas (uma vez por dia, depois das 18h30) ----------
const agora = new Date();
const minutosBR = ((agora.getUTCHours() + 21) % 24) * 60 + agora.getUTCMinutes();
const lerData = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).atualizadoEm : '');
const forcar = process.env.HISTORICO === '1';
const ultimoDia = lerData('site/historico/mundo.json');
if (forcar || !ultimoDia || (diaBR(new Date(ultimoDia)) !== diaBR(agora) && minutosBR >= 18 * 60 + 30)) {
  for (const [id, s] of Object.entries(MUNDO)) {
    const v = velas(await grafico(s, '3mo', '1d'));
    if (v.length) writeFileSync(`site/historico/${id}.json`, JSON.stringify(v));
    await espera(300);
  }
  writeFileSync('site/historico/mundo.json', JSON.stringify({ atualizadoEm: agora.toISOString() }));
  writeFileSync('.historico-novo', '1');
}

// ---------- 5 anos semanais (uma vez por semana) ----------
const ultimoLongo = lerData('site/longo/indice.json');
const semana = 6.5 * 24 * 3600 * 1000;
if (forcar || !ultimoLongo || agora - new Date(ultimoLongo) > semana) {
  const lista = existsSync('site/historico/indice.json') ? JSON.parse(readFileSync('site/historico/indice.json', 'utf8')).tickers : [];
  const alvos = [['IBOV', '^BVSP'], ...Object.entries(MUNDO), ...lista.filter((t) => t !== 'IBOV' && t !== 'IFIX').map((t) => [t, `${t}.SA`])];
  let feitos = 0;
  for (const [id, s] of alvos) {
    const v = velas(await grafico(s, '5y', '1wk'));
    if (v.length > 10) { writeFileSync(`site/longo/${id}.json`, JSON.stringify(v)); feitos++; }
    await espera(400);
  }
  writeFileSync('site/longo/indice.json', JSON.stringify({ atualizadoEm: agora.toISOString(), tickers: alvos.map((a) => a[0]) }));
  writeFileSync('.historico-novo', '1');
  console.log(`5 anos: ${feitos} de ${alvos.length}`);
}
console.log(`ok: mundo (${Object.keys(mundo).length} cotações)`);
