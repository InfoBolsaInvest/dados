// Histórico do IFIX direto da B3 (as fontes grátis de cotação não têm): a B3 publica o fechamento de cada dia
// do ano em "Estatísticas dos índices". Monta o gráfico diário de 3 meses (historico/IFIX.json) e o semanal de
// 5 anos (longo/IFIX.json), no mesmo formato dos outros. 1x por dia depois das 18h30, ou se ainda não existe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const agora = new Date();
const brt = new Date(agora.getTime() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
const ARQ = 'site/historico/IFIX.json';
const atual = existsSync(ARQ) ? JSON.parse(readFileSync(ARQ, 'utf8')) : [];
const ultimoDia = atual.length ? String(atual[atual.length - 1][0]) : '';
// (velas achatadas = arquivo da primeira versão, sem a abertura no fechamento anterior: refaz uma vez)
const forcar = process.env.HISTORICO === '1' || atual.length < 5 || !existsSync('site/longo/IFIX.json') || atual.every((v) => v[1] === v[4]);
if (!forcar && (ultimoDia === hoje || minutos < 18 * 60 + 30)) { console.log('IFIX: já está em dia'); process.exit(0); }

async function ano(a) {
  const p = Buffer.from(JSON.stringify({ index: 'IFIX', language: 'pt-br', year: String(a) })).toString('base64');
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(`https://sistemaswebb3-listados.b3.com.br/indexStatisticsProxy/IndexCall/GetPortfolioDay/${p}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`B3 ${r.status}`);
      const j = await r.json();
      const out = [];
      for (const linha of j.results || []) {
        for (let m = 1; m <= 12; m++) {
          const v = linha[`rateValue${m}`];
          if (!v) continue;
          const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
          if (n > 0) out.push([`${a}-${String(m).padStart(2, '0')}-${String(linha.day).padStart(2, '0')}`, n]);
        }
      }
      return out;
    } catch (e) {
      if (tentativa === 3) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * tentativa));
    }
  }
  return [];
}

const anoAtual = Number(hoje.slice(0, 4));
const dias = (await Promise.all([0, 1, 2, 3, 4, 5].map((k) => ano(anoAtual - k)))).flat().sort((x, y) => (x[0] < y[0] ? -1 : 1));
if (dias.length < 50) throw new Error(`a B3 devolveu só ${dias.length} dias`);
// ano passado com poucos pregões é resposta pela metade da B3: sem regravar, fica o arquivo de antes
for (let a = anoAtual - 4; a < anoAtual; a++) {
  const n = dias.filter(([d]) => d.startsWith(String(a))).length;
  if (n < 200) throw new Error(`a B3 devolveu só ${n} pregões de ${a}`);
}

// diário: últimos ~3 meses (mesmo tamanho dos outros históricos), [dia, abertura, máxima, mínima, fechamento].
// A B3 só dá o fechamento: cada vela abre no fechamento do dia anterior (senão o candle vira um tracinho)
const diario = dias.slice(-64).map(([d, c], i, l) => { const a = i ? l[i - 1][1] : c; return [d, a, Math.max(a, c), Math.min(a, c), c]; }).slice(1);
// semanal: cada semana começando na segunda-feira, com o primeiro, o maior, o menor e o último fechamento
const semanas = new Map();
for (const [d, c] of dias) {
  const dt = new Date(d + 'T12:00:00Z');
  const seg = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const s = semanas.get(seg);
  if (s) { s[2] = Math.max(s[2], c); s[3] = Math.min(s[3], c); s[4] = c; } else {
    // a semana abre no fechamento da semana anterior
    const ant = [...semanas.values()].pop();
    const a = ant ? ant[4] : c;
    semanas.set(seg, [seg, a, Math.max(a, c), Math.min(a, c), c]);
  }
}
const semanal = [...semanas.values()].slice(-262);
mkdirSync('site/longo', { recursive: true });
writeFileSync(ARQ, JSON.stringify(diario));
writeFileSync('site/longo/IFIX.json', JSON.stringify(semanal));
writeFileSync('.historico-novo', '1'); // guarda no cache do Actions
console.log(`ok: IFIX da B3 (${dias.length} pregões, até ${dias[dias.length - 1][0]})`);
