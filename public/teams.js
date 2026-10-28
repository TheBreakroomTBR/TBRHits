// Shared by index.html and admin.html
window.GG = (() => {
  const TEAMS = [
    ["Arizona Cardinals","ARI","#97233F","#FFB612"],["Atlanta Falcons","ATL","#A71930","#000000"],
    ["Baltimore Ravens","BAL","#241773","#9E7C0C"],["Buffalo Bills","BUF","#00338D","#C60C30"],
    ["Carolina Panthers","CAR","#0085CA","#101820"],["Chicago Bears","CHI","#0B162A","#C83803"],
    ["Cincinnati Bengals","CIN","#FB4F14","#000000"],["Cleveland Browns","CLE","#311D00","#FF3C00"],
    ["Dallas Cowboys","DAL","#003594","#869397"],["Denver Broncos","DEN","#FB4F14","#002244"],
    ["Detroit Lions","DET","#0076B6","#B0B7BC"],["Green Bay Packers","GB","#203731","#FFB612"],
    ["Houston Texans","HOU","#03202F","#A71930"],["Indianapolis Colts","IND","#002C5F","#A2AAAD"],
    ["Jacksonville Jaguars","JAX","#006778","#D7A22A"],["Kansas City Chiefs","KC","#E31837","#FFB81C"],
    ["Las Vegas Raiders","LV","#000000","#A5ACAF"],["Los Angeles Chargers","LAC","#0080C6","#FFC20E"],
    ["Los Angeles Rams","LAR","#003594","#FFA300"],["Miami Dolphins","MIA","#008E97","#FC4C02"],
    ["Minnesota Vikings","MIN","#4F2683","#FFC62F"],["New England Patriots","NE","#002244","#C60C30"],
    ["New Orleans Saints","NO","#101820","#D3BC8D"],["New York Giants","NYG","#0B2265","#A71930"],
    ["New York Jets","NYJ","#125740","#FFFFFF"],["Philadelphia Eagles","PHI","#004C54","#A5ACAF"],
    ["Pittsburgh Steelers","PIT","#101820","#FFB612"],["San Francisco 49ers","SF","#AA0000","#B3995D"],
    ["Seattle Seahawks","SEA","#002244","#69BE28"],["Tampa Bay Buccaneers","TB","#D50A0A","#34302B"],
    ["Tennessee Titans","TEN","#0C2340","#4B92DB"],["Washington Commanders","WAS","#5A1414","#FFB612"],
  ].map(([name, abbr, c1, c2]) => ({ name, abbr, c1, c2, nick: name.split(" ").pop() }));

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function findTeam(input) {
    const n = norm(input);
    if (!n) return null;
    return TEAMS.find((t) => norm(t.name) === n || norm(t.abbr) === n || norm(t.nick) === n)
      || TEAMS.find((t) => n.includes(norm(t.nick)))
      || null;
  }
  function teamStyle(input) {
    const t = findTeam(input);
    return t || { name: input || "Unknown", abbr: (String(input || "?").replace(/[^A-Za-z]/g, "").slice(0, 3) || "?").toUpperCase(), c1: "#2d1b69", c2: "#c9b800" };
  }

  function trackingUrl(num) {
    const t = String(num || "").replace(/\s+/g, "").toUpperCase();
    if (!t) return null;
    if (/^1Z[0-9A-Z]{16}$/.test(t)) return { carrier: "UPS", url: `https://www.ups.com/track?tracknum=${t}` };
    if (/^(\d{12}|\d{15}|\d{20})$/.test(t) && !/^9[2-5]/.test(t)) return { carrier: "FedEx", url: `https://www.fedex.com/fedextrack/?trknbr=${t}` };
    if (/^(9[2-5]\d{18,24}|[A-Z]{2}\d{9}US|\d{20,22})$/.test(t)) return { carrier: "USPS", url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}` };
    return { carrier: "Carrier", url: `https://www.google.com/search?q=${encodeURIComponent(t + " tracking")}` };
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d) => {
    if (!d) return "";
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  // Simple side-profile football helmet in team colors for each hit card.
  function helmetSvg(team) {
    const t = teamStyle(team);
    return `<svg viewBox="0 0 200 140" aria-hidden="true"><g>
      <path d="M28 92 C22 50 52 18 98 16 C140 14 168 40 170 76 L170 96 L128 96 L120 112 L58 114 C40 114 31 106 28 92 Z" fill="${t.c1}"/>
      <path d="M44 40 C62 22 96 14 128 20" stroke="${t.c2}" stroke-width="9" fill="none" stroke-linecap="round"/>
      <path d="M28 92 C22 50 52 18 98 16 C140 14 168 40 170 76 L170 96 L128 96 L120 112 L58 114 C40 114 31 106 28 92 Z" fill="url(#shine)" opacity=".5"/>
      <circle cx="92" cy="78" r="7" fill="#000" opacity=".35"/>
      <path d="M150 70 H192 M150 88 H192 M190 64 V104 M170 104 H192 M150 70 C142 80 142 92 150 104" stroke="#c9c9cf" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </g><defs><linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>`;
  }

  // "JALEN HURTS (Authentic)" -> { player, type }
  function splitHelmet(h) { const m = String(h || "").match(/^(.*?)\s*\((Authentic|Speed Flex)\)\s*$/i); return m ? { player: m[1], type: m[2] } : { player: h || "", type: "" }; }

  return { TEAMS, findTeam, teamStyle, trackingUrl, esc, fmtDate, helmetSvg, splitHelmet };
})();
