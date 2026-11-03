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
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const ev = [];
for (const [dec, ata] of COPOM) {
  ev.push({ d: dec, t: 'Decisão do Copom', s: 'Define a Selic, o juro básico que mexe na renda fixa e na bolsa' });
  ev.push({ d: ata, t: 'Ata do Copom', s: 'Explica a decisão e dá pistas dos próximos passos do juro' });
}
for (const [d, nome] of FERIADOS) ev.push({ d, t: 'Sem pregão na B3', s: nome });

try {
  const fim = new Date(Date.now() + 200 * 86400 * 1000);
  const br = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const r = await fetch(`https://servicodados.ibge.gov.br/api/v3/calendario/?de=${br(new Date())}&ate=${br(fim)}&qtd=500`);
  const j = await r.json();
  for (const x of j.items || j) {
    const nome = x.nome_produto || x.titulo || '';
    const dia = (x.data_divulgacao || '').slice(0, 10);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dia)) continue;
    const d = `${dia.slice(6)}-${dia.slice(3, 5)}-${dia.slice(0, 2)}`;
    const mes = MESES[(Number(x.mes_referencia_inicio) || 0) - 1];
    if (/Consumidor Amplo 15$/.test(nome)) ev.push({ d, t: `IPCA-15${mes ? ' de ' + mes : ''}`, s: 'Prévia da inflação do mês' });
    else if (/Consumidor Amplo$/.test(nome)) ev.push({ d, t: `IPCA${mes ? ' de ' + mes : ''}`, s: 'A inflação oficial, que o Copom olha pra decidir o juro' });
    else if (/Produto Interno Bruto/i.test(nome) && /Trimestral/i.test(nome)) ev.push({ d, t: 'PIB do trimestre', s: 'Mostra se a economia cresceu ou encolheu' });
  }
} catch (e) { console.log(`IBGE: ${e.message}`); }

const vistos = new Set();
const lista = ev.filter((e) => e.d >= hoje && !vistos.has(e.d + e.t) && vistos.add(e.d + e.t)).sort((a, b) => (a.d < b.d ? -1 : 1));
writeFileSync('site/calendario.json', JSON.stringify(lista));
console.log(`ok: agenda com ${lista.length} eventos`);
