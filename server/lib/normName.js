// Same-named places count once; case, spacing, curly quotes and accents are ignored.
module.exports = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, ' ').trim();
