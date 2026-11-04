// Custo atribuído das bonificações (o valor por ação que a Receita manda somar ao custo das ações bonificadas).
// A B3 dá a bonificação sem esse valor; ele vem no aviso aos acionistas ou no fato relevante da empresa, na CVM.
// Roda depois do fundamentos.mjs, na rodada em que ele refez o dia (precisa do .cvm-codigos.json): acha o documento
// na lista de documentos da CVM (IPE, dados abertos), lê o texto do PDF e procura "custo atribuído ... R$ X".
// Sem IA: quando o texto não traz o valor, grava 0 (não achado) e o app avisa que o custo ficou sem valor.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (!existsSync('.cvm-codigos.json')) { console.log('eventos: fundamentos não refeitos nesta rodada, nada a fazer'); process.exit(0); }
const codigos = JSON.parse(readFileSync('.cvm-codigos.json', 'utf8'));
const fund = JSON.parse(readFileSync('site/fundamentos.json', 'utf8'));
const POR_RODADA = 25;
const DESDE = '2018-01-01';

const faltam = [];
for (const [tk, x] of Object.entries(fund.a)) {
  for (const e of x.e || []) if (e[1] === 'bon' && e.length < 5 && e[0] >= DESDE && codigos[tk.slice(0, 4)]) faltam.push({ tk, e });
}
if (!faltam.length) { console.log('eventos: nenhuma bonificação sem custo'); process.exit(0); }

execSync('npm i --no-save --silent pdfjs-dist@4.10.38', { stdio: 'ignore' });
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

// lista de documentos da CVM de um ano (cache na rodada)
const anos = {};
async function ipe(ano) {
  if (anos[ano]) return anos[ano];
  const r = await fetch(`https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_${ano}.zip`);
  if (!r.ok) return (anos[ano] = []);
  writeFileSync('.ipe.zip', Buffer.from(await r.arrayBuffer()));
  const linhas = execSync(`unzip -p .ipe.zip ipe_cia_aberta_${ano}.csv`, { maxBuffer: 256 * 1024 * 1024 }).toString('latin1').split(/\r?\n/).map((l) => l.split(';'));
  const c = linhas[0];
  const i = (n) => c.indexOf(n);
  return (anos[ano] = linhas.slice(1).map((l) => ({ cvm: l[i('Codigo_CVM')], cat: l[i('Categoria')], assunto: l[i('Assunto')], dia: l[i('Data_Entrega')], link: l[i('Link_Download')] })));
}

async function texto(link) {
  const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return '';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await r.arrayBuffer()), useSystemFonts: true }).promise;
  let t = '';
  for (let p = 1; p <= Math.min(pdf.numPages, 15); p++) t += ' ' + (await (await pdf.getPage(p)).getTextContent()).items.map((x) => x.str).join(' ');
  return t.replace(/\s+/g, ' ');
}

// "custo atribuído às ações bonificadas será de R$ 10,82550951208 por ação" e variações
function custo(t) {
  for (const m of t.matchAll(/custo[^.;]{0,200}?R\$ ?([\d.]*\d,\d+)/gi)) {
    if (!/atribu/i.test(m[0])) continue;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    if (v > 0 && v < 10000) return Math.round(v * 1e8) / 1e8;
  }
  return 0;
}

const somaDias = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
let achados = 0, feitos = 0;
for (const { tk, e } of faltam.slice(0, POR_RODADA)) {
  const [com, , , aprovado] = e;
  const de = somaDias(aprovado || com, -15), ate = somaDias(com, 10);
  const docs = [];
  for (const ano of new Set([de.slice(0, 4), ate.slice(0, 4)])) docs.push(...(await ipe(ano)));
  const cands = docs.filter((d) => d.cvm === codigos[tk.slice(0, 4)] && d.dia >= de && d.dia <= ate && /bonifica/i.test(d.assunto + ' ' + d.cat))
    .sort((a, b) => (a.cat === 'Aviso aos Acionistas' ? -1 : 0) - (b.cat === 'Aviso aos Acionistas' ? -1 : 0));
  let v = 0;
  for (const d of cands.slice(0, 4)) {
    try { v = custo(await texto(d.link)); } catch {}
    if (v) break;
  }
  e[4] = v;
  feitos++;
  if (v) achados++;
  console.log(`  ${tk} bonificação de ${com}: ${v ? `R$ ${v} por ação` : `custo não achado (${cands.length} documento(s))`}`);
}
writeFileSync('site/fundamentos.json', JSON.stringify(fund));
console.log(`eventos: ${feitos} bonificação(ões) conferida(s), ${achados} com custo achado, ${Math.max(0, faltam.length - feitos)} para as próximas rodadas`);
