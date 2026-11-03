// Conferência com o arquivo oficial da B3 (COTAHIST do último pregão, grátis): todo ativo negociado
// no mercado à vista que não veio da brapi entra no catálogo, com o preço de fechamento da B3.
// Roda depois do atualizar.mjs e só acrescenta; nunca tira nada do que a brapi trouxe.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// categorias da B3 que não são ativo pra acompanhar: 10 direitos de subscrição, 22 bônus de subscrição
const FORA = new Set(['10', '22']);
const TIPO = { '12': 'fii', '13': 'fii', '14': 'etf', '34': 'bdr', '35': 'bdr', '36': 'bdr' };

async function ultimoPregao() {
  for (let d = 0; d < 7; d++) {
    const dia = new Date(Date.now() - 3 * 3600 * 1000 - d * 86400 * 1000);
    const nome = `COTAHIST_D${String(dia.getUTCDate()).padStart(2, '0')}${String(dia.getUTCMonth() + 1).padStart(2, '0')}${dia.getUTCFullYear()}`;
    const r = await fetch(`https://bvmf.bmfbovespa.com.br/InstDados/SerHist/${nome}.ZIP`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) continue;
    const zip = Buffer.from(await r.arrayBuffer());
    if (zip.length < 10000 || zip[0] !== 0x50) continue; // fim de semana/feriado: a B3 devolve uma página, não o zip
    writeFileSync('.cotahist.zip', zip);
    return execSync('unzip -p .cotahist.zip', { maxBuffer: 64 * 1024 * 1024 }).toString('latin1');
  }
  throw new Error('arquivo da B3 não encontrado nos últimos 7 dias');
}

const txt = await ultimoPregao();
const catalogo = JSON.parse(readFileSync('site/catalogo.json', 'utf8'));
const cotacoes = JSON.parse(readFileSync('site/cotacoes.json', 'utf8'));
const novos = [];
for (const l of txt.split(/\r?\n/)) {
  if (!l.startsWith('01') || l.slice(24, 27) !== '010') continue; // só mercado à vista
  const bdi = l.slice(10, 12);
  const tk = l.slice(12, 24).trim();
  if (FORA.has(bdi) || catalogo.a[tk] || !/^[A-Z0-9]{4}\d{1,2}$/.test(tk)) continue;
  const fech = Number(l.slice(108, 121)) / 100;
  const vol = Math.round(Number(l.slice(170, 188)) / 100);
  if (!(fech > 0)) continue;
  // o nome fica igual ao ticker: o nomes.mjs busca o nome certo no Yahoo
  catalogo.a[tk] = [tk, TIPO[bdi] || (tk.endsWith('11') ? 'fii' : 'acao'), '', 0, vol];
  cotacoes.q[tk] = [fech, 0];
  novos.push(tk);
}
if (novos.length) {
  cotacoes.total = Object.keys(cotacoes.q).length;
  writeFileSync('site/catalogo.json', JSON.stringify(catalogo));
  writeFileSync('site/cotacoes.json', JSON.stringify(cotacoes));
}
console.log(`B3: ${novos.length} ativo(s) que a brapi não trouxe${novos.length ? ': ' + novos.join(' ') : ''}`);
