// Gráfico do que ainda ficou sem: a brapi só dá os 250 mais negociados, o Yahoo semanal segue essa lista e o arquivo da
// B3 (b3hist.mjs) não traz quem não negocia no mercado à vista com código próprio (vários ETFs de renda fixa, alguns
// FIIs e Fiagros novos). Para esses, o Yahoo: site/historico/TK.json (3 meses, diário) e site/longo/TK.json (5 anos,
// semanal), no mesmo formato. Uma vez por dia, depois das 18h30 (ou forçado com HISTORICO=1), até 80 de cada.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const agora = new Date();
const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const minutosBR = ((agora.getUTCHours() + 21) % 24) * 60 + agora.getUTCMinutes();
const MARCA = 'site/longo/faltam.json';
const feito = existsSync(MARCA) ? JSON.parse(readFileSync(MARCA, 'utf8')).dia : '';
if (process.env.HISTORICO !== '1' && (feito === diaBR(agora) || minutosBR < 18 * 60 + 30)) { console.log('ok: gráficos que faltavam já vistos hoje'); process.exit(0); }

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function velas(tk, range, interval) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${tk}.SA?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const res = (await r.json())?.chart?.result?.[0];
    const t = res?.timestamp || [];
    const q = res?.indicators?.quote?.[0] || {};
    const off = (res?.meta?.gmtoffset || 0) * 1000;
    const out = [];
    t.forEach((s, i) => {
      const c = q.close?.[i];
      if (!(c > 0)) return;
      const dia = new Date(s * 1000 + off + 12 * 3600 * 1000).toISOString().slice(0, 10);
      const r4 = (x) => Math.round((x || c) * 10000) / 10000;
      const v = [dia, r4(q.open?.[i]), r4(q.high?.[i]), r4(q.low?.[i]), r4(c)];
      if (out.length && out[out.length - 1][0] === dia) out[out.length - 1] = v; else out.push(v);
    });
    // vela sozinha muito longe das vizinhas é ponto errado do Yahoo
    return out.filter((v, i) => { const a = out[i - 1], b = out[i + 1]; return !a || !b || Math.abs(b[4] / a[4] - 1) > 0.2 || Math.abs(v[4] / a[4] - 1) < 0.5; });
  } catch { return []; }
}

mkdirSync('site/historico', { recursive: true });
mkdirSync('site/longo', { recursive: true });
// os mais negociados primeiro (volume em ações do catálogo)
const tks = Object.keys(cat).sort((a, b) => (cat[b][4] || 0) - (cat[a][4] || 0));
const semDiario = tks.filter((tk) => !existsSync(`site/historico/${tk}.json`)).slice(0, 80);
const semLongo = tks.filter((tk) => !existsSync(`site/longo/${tk}.json`)).slice(0, 80);
let d = 0, s = 0;
for (const tk of semDiario) { const v = await velas(tk, '3mo', '1d'); if (v.length >= 5) { writeFileSync(`site/historico/${tk}.json`, JSON.stringify(v)); d++; } await espera(300); }
for (const tk of semLongo) { const v = await velas(tk, '5y', '1wk'); if (v.length > 10) { writeFileSync(`site/longo/${tk}.json`, JSON.stringify(v)); s++; } await espera(300); }
writeFileSync(MARCA, JSON.stringify({ dia: diaBR(agora) }));
writeFileSync('.historico-novo', '1');
console.log(`ok: Yahoo para os que faltavam: diário de ${d} (de ${semDiario.length}) e semanal de ${s} (de ${semLongo.length})`);
