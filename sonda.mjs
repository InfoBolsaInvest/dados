// teste temporário: o que o plano grátis da brapi libera com token (não imprime o token)
const T = process.env.BRAPI_TOKEN;
for (const tk of ['BBAS3', 'MXRF11', 'WEGE3']) {
  const r = await fetch(`https://brapi.dev/api/quote/${tk}?dividends=true&modules=defaultKeyStatistics&token=${T}`);
  const j = await r.json();
  const x = j.results?.[0] || {};
  console.log(tk, r.status, j.error ? j.message : '', 'divs:', x.dividendsData?.cashDividends?.length ?? 'nao', 'pb:', x.defaultKeyStatistics?.priceToBook ?? 'nao');
}
