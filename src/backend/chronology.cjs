function compareVersions(a, b) {
  const parts = (v) => String(v || "").match(/^([67])\.(\d{2})([a-z]?)$/);
  const x = parts(a),
    y = parts(b);
  if (!x || !y)
    return String(a || "").localeCompare(String(b || ""), "en", {
      numeric: true,
    });
  return (
    Number(x[1]) - Number(y[1]) ||
    Number(x[2]) - Number(y[2]) ||
    x[3].localeCompare(y[3])
  );
}
function compareHistory(a, b) {
  return (
    a.year - b.year ||
    Number(!a.date) - Number(!b.date) ||
    String(a.date || "").localeCompare(String(b.date || "")) ||
    compareVersions(a.version, b.version) ||
    a.id.localeCompare(b.id)
  );
}
module.exports = { compareVersions, compareHistory };
