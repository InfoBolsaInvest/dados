// Agenda do mercado (toda rodada, é leve): Copom e feriados da B3 (datas oficiais, revisar todo ano)
// e IPCA, IPCA-15 e PIB direto da API de calendário do IBGE.
// Gera site/calendario.json [{ d: aaaa-mm-dd, t: título, s: explicação curta }]
import { writeFileSync } from 'node:fs';

// Banco Central: decisão no 2º dia da reunião, ata na terça seguinte às 8h. Calendário de 2027 publicado em 23/06/2026.
const COPOM = [
  ['2026-11-04', '2026-11-10'], ['2026-12-09', '2026-12-15'],
  ['2027-01-27', '2027-02-02'], ['2027-03-17', '2027-03-23'], ['2027-04-28', '2027-05-04'], ['2027-06-16', '2027-06-22'],
  ['2027-08-04', '2027-08-10'], ['2027-09-22', '2027-09-28'], ['2027-10-27', '2027-11-03'], ['2027-12-08', '2027-12-14'],
];
// dias sem pregão na B3 (feriados nacionais e os fechamentos de fim de ano)
const FERIADOS = [
  ['2026-11-02', 'Finados'], ['2026-11-20', 'Dia da Consciência Negra'], ['2026-12-24', 'Véspera de Natal'], ['2026-12-25', 'Natal'], ['2026-12-31', 'Último dia do ano'],
  ['2027-01-01', 'Ano-novo'], ['2027-02-08', 'Carnaval'], ['2027-02-09', 'Carnaval'], ['2027-03-26', 'Sexta-feira Santa'],
  ['2027-04-21', 'Tiradentes'], ['2027-05-27', 'Corpus Christi'], ['2027-09-07', 'Independência'], ['2027-10-12', 'Nossa Senhora Aparecida'],
  ['2027-11-02', 'Finados'], ['2027-11-15', 'Proclamação da República'], ['2027-12-24', 'Véspera de Natal'], ['2027-12-31', 'Último dia do ano'],
];
// ---------- lá de fora, que mexe com dólar e bolsa aqui ----------
const EXTERIOR = [
  ['2026-11-03', 'Eleição nos EUA', 'Renova o Congresso americano; costuma mexer com o dólar e com as bolsas'],
];
// Fed e BCE: lidos do site oficial a cada rodada; estas são a reserva (conferidas nos sites em 03/11/2026)
const FED_RESERVA = ['2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
// IBGE: a API bloqueia quem acessa de fora do Brasil (os servidores do GitHub ficam nos EUA), então quase sempre
// vale esta reserva, tirada da mesma API daqui do Brasil. [dia, indicador, mês de referência]. Quando faltar
// IPCA nos próximos 40 dias o passo falha de propósito e o Telegram avisa: é hora de completar a lista.
const IBGE_RESERVA = [
  ['2026-11-12', 'IPCA', 10], ['2026-11-26', 'IPCA-15', 11], ['2026-12-02', 'PIB', 7], ['2026-12-11', 'IPCA', 11],
  ['2026-12-23', 'IPCA-15', 12], ['2027-01-12', 'IPCA', 12], ['2027-03-02', 'PIB', 10],
];
const BCE_RESERVA = ['2026-12-17', '2027-02-04', '2027-03-18', '2027-04-29', '2027-06-10', '2027-07-22', '2027-09-09', '2027-10-28', '2027-12-16'];
// BLS (órgão de estatística dos EUA): o site bloqueia robôs, então as datas ficam aqui. Rever todo ano (o BLS
// publica o ano seguinte no fim do ano). Conferidas em bls.gov em 03/11/2026. [data, mês de referência]
const CPI_EUA = [['2026-11-10', 9], ['2026-12-10', 10], ['2027-01-13', 11], ['2027-02-11', 0], ['2027-03-10', 1], ['2027-04-13', 2], ['2027-05-12', 3],
  ['2027-06-10', 4], ['2027-07-14', 5], ['2027-08-11', 6], ['2027-09-14', 7], ['2027-10-14', 8], ['2027-11-10', 9], ['2027-12-10', 10]];
const EMPREGO_EUA = ['2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07', '2027-06-04', '2027-07-02',
  '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03'];
const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' };

// Fed: "December 8-9" ou "April/May 30-1" -> o 2º dia é o da decisão
async function datasFed() {
  const html = await (await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: UA })).text();
  const out = [];
  for (const [, ano, bloco] of html.matchAll(/>(\d{4}) FOMC Meetings<([\s\S]*?)(?=>\d{4} FOMC Meetings<|$)/g)) {
    for (const [, mes, dias] of bloco.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const m = mes.trim().split('/').pop();
      const d = dias.trim().match(/(\d+)\D*$/)?.[1];
      const i = MESES_EN.findIndex((x) => x.startsWith(m.slice(0, 3)));
      if (d && i >= 0) out.push(`${ano}-${String(i + 1).padStart(2, '0')}-${d.padStart(2, '0')}`);
    }
  }
  if (out.length < 8) throw new Error('página do Fed mudou');
  return out;
}
// BCE: a decisão sai no dia 2 da reunião de política monetária, com entrevista coletiva
async function datasBce() {
  const html = await (await fetch('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html', { headers: UA })).text();
  const t = html.replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length - 1; i++) {
    const m = t[i].match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m && /monetary policy meeting.*Day 2/i.test(t[i + 1])) out.push(`${m[3]}-${m[2]}-${m[1]}`);
  }
  if (out.length < 4) throw new Error('página do BCE mudou');
  return out;
}
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const ev = [];
for (const [dec, ata] of COPOM) {
  ev.push({ d: dec, t: 'Decisão do Copom', s: 'Define a Selic, o juro básico que mexe na renda fixa e na bolsa' });
  ev.push({ d: ata, t: 'Ata do Copom', s: 'Explica a decisão e dá pistas dos próximos passos do juro' });
}
for (const [d, nome] of FERIADOS) ev.push({ d, t: 'Sem pregão na B3', s: nome });
for (const [d, t, s] of EXTERIOR) ev.push({ d, t, s });
const fed = await datasFed().catch((e) => { console.log(`Fed: ${e.message}, usei a reserva`); return FED_RESERVA; });
for (const d of fed) ev.push({ d, t: 'Decisão de juros nos EUA (Fed)', s: 'O juro americano mexe com o dólar e com o dinheiro estrangeiro na bolsa daqui' });
const bce = await datasBce().catch((e) => { console.log(`BCE: ${e.message}, usei a reserva`); return BCE_RESERVA; });
for (const d of bce) ev.push({ d, t: 'Decisão de juros na Europa (BCE)', s: 'Mexe com o euro e com o humor dos mercados lá fora' });
for (const [d, m] of CPI_EUA) ev.push({ d, t: `Inflação nos EUA (CPI de ${MESES[m]})`, s: 'Se vier alta, o juro americano tende a ficar alto por mais tempo, o que costuma pesar no dólar e na bolsa daqui' });
for (const d of EMPREGO_EUA) ev.push({ d, t: 'Emprego nos EUA (payroll)', s: 'Mostra a força da economia americana; costuma mexer com o dólar' });

const ibge = [];
try {
  const fim = new Date(Date.now() + 200 * 86400 * 1000);
  const br = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const r = await fetch(`https://servicodados.ibge.gov.br/api/v3/calendario/?de=${br(new Date())}&ate=${br(fim)}&qtd=500`, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  for (const x of j.items || j) {
    const nome = x.nome_produto || x.titulo || '';
    const dia = (x.data_divulgacao || '').slice(0, 10);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dia)) continue;
    const d = `${dia.slice(6)}-${dia.slice(3, 5)}-${dia.slice(0, 2)}`;
    const tipo = /Consumidor Amplo 15$/.test(nome) ? 'IPCA-15' : /Consumidor Amplo$/.test(nome) ? 'IPCA'
      : /Contas Nacionais Trimestrais/i.test(nome) || (/Produto Interno Bruto/i.test(nome) && /Trimestral/i.test(nome)) ? 'PIB' : '';
    if (tipo) ibge.push([d, tipo, Number(x.mes_referencia_inicio) || 0]);
  }
  if (!ibge.some((x) => x[1] === 'IPCA')) throw new Error('veio sem IPCA');
  console.log(`IBGE: ${ibge.length} datas`);
} catch (e) { console.log(`IBGE: ${e.message}, usei a reserva`); ibge.splice(0, ibge.length, ...IBGE_RESERVA); }
for (const [d, tipo, m] of ibge) {
  const mes = MESES[m - 1];
  // PIB: o mês de referência é o 1º do trimestre (7 = 3º trimestre)
  if (tipo === 'PIB') ev.push({ d, t: `PIB do ${m ? Math.ceil(m / 3) + 'º ' : ''}trimestre`, s: 'Mostra se a economia cresceu ou encolheu' });
  else if (tipo === 'IPCA-15') ev.push({ d, t: `IPCA-15${mes ? ' de ' + mes : ''}`, s: 'Prévia da inflação do mês' });
  else ev.push({ d, t: `IPCA${mes ? ' de ' + mes : ''}`, s: 'A inflação oficial, que o Copom olha pra decidir o juro' });
}

const vistos = new Set();
const lista = ev.filter((e) => e.d >= hoje && !vistos.has(e.d + e.t) && vistos.add(e.d + e.t)).sort((a, b) => (a.d < b.d ? -1 : 1));
writeFileSync('site/calendario.json', JSON.stringify(lista));
console.log(`ok: agenda com ${lista.length} eventos`);
const em40 = new Date(Date.now() + 40 * 86400 * 1000).toISOString().slice(0, 10);
if (!ibge.some((x) => x[1] === 'IPCA' && x[0] >= hoje && x[0] <= em40)) throw new Error('sem data de IPCA nos próximos 40 dias: completar IBGE_RESERVA em calendario.mjs');
