// index.js — Pokédex chatbot API (CommonJS, deploy-ready)
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public"))); // serve UI

// IMPORTANT for Render/Railway: listen on provided PORT
const PORT = process.env.PORT || 3000;

/* --- tiny cache helper --- */
const cache = new Map();
const TTL_MS = 1000 * 60 * 10;
async function cachedJSON(url) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.t < TTL_MS) return hit.v;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
  const v = await r.json();
  cache.set(url, { v, t: now });
  return v;
}

/* --- PokéAPI helpers --- */
const API = "https://pokeapi.co/api/v2";
async function getPokemon(n) { return cachedJSON(`${API}/pokemon/${encodeURIComponent(String(n).toLowerCase())}`); }
async function getSpecies(n) { return cachedJSON(`${API}/pokemon-species/${encodeURIComponent(String(n).toLowerCase())}`); }
async function getType(t)   { return cachedJSON(`${API}/type/${encodeURIComponent(String(t).toLowerCase())}`); }
async function getEvolutionChainByUrl(u) { return cachedJSON(u); }

const ALL_TYPES = ["normal","fire","water","electric","grass","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];

async function weaknessesForPokemon(p) {
  const mult = Object.fromEntries(ALL_TYPES.map(t => [t, 1]));
  for (const t of p.types.map(t => t.type.name)) {
    const rel = (await getType(t)).damage_relations;
    for (const x of rel.double_damage_from) mult[x.name] *= 2;
    for (const x of rel.half_damage_from)   mult[x.name] *= 0.5;
    for (const x of rel.no_damage_from)     mult[x.name] *= 0;
  }
  const entries = Object.entries(mult);
  return {
    weaknesses: entries.filter(([,m]) => m > 1).sort((a,b)=>b[1]-a[1]),
    resistances: entries.filter(([,m]) => m > 0 && m < 1).sort((a,b)=>a[1]-b[1]),
    immunities: entries.filter(([,m]) => m === 0)
  };
}

function flattenChain(chain) {
  const paths = [];
  (function walk(node, acc) {
    const next = [...acc, node.species.name];
    if (!node.evolves_to?.length) paths.push(next);
    else node.evolves_to.forEach(n => walk(n, next));
  })(chain.chain, []);
  return paths;
}

function routeIntent(q) {
  const text = String(q || "").toLowerCase().trim();
  const cmp = text.match(/(who( is|'s)? faster|compare speed)\s+([a-z0-9\-\.]+)\s+(?:vs|or|versus)\s+([a-z0-9\-\.]+)/);
  if (cmp) return { intent: "compare_speed", a: cmp[3], b: cmp[4] };
  const w   = text.match(/weak(ness|nesses)? of ([a-z0-9\-\s\.]+)/);
  if (w) return { intent: "weaknesses", name: w[2].trim() };
  const evo = text.match(/(evolutions?|evo(?: line)?|evolution of) ([a-z0-9\-\s\.]+)/);
  if (evo) return { intent: "evolution", name: evo[2].trim() };
  const stats = text.match(/(base )?stats? of ([a-z0-9\-\s\.]+)/);
  if (stats) return { intent: "stats", name: stats[2].trim() };
  const typeQ = text.match(/(what (is|are) )?(the )?types? of ([a-z0-9\-\s\.]+)/);
  if (typeQ) return { intent: "types", name: typeQ[4].trim() };
  const move = text.match(/(what does|info on|details for) move ([a-z0-9\-\s\.]+)/);
  if (move) return { intent: "move", move: move[2].trim() };
  return { intent: "dex", name: text.split(/\s+/).pop() };
}

/* ---- Routes ---- */
app.get("/status", (_req, res) => res.send("Pokédex Bot API is running. Try /ask?q=weaknesses%20of%20Garchomp"));

app.get("/pokemon/:name", async (req, res) => {
  try {
    const p = await getPokemon(req.params.name);
    res.json({
      name: p.name,
      id: p.id,
      types: p.types.map(t=>t.type.name),
      abilities: p.abilities.map(a=>a.ability.name),
      stats: Object.fromEntries(p.stats.map(s=>[s.stat.name, s.base_stat])),
      sprite: p.sprites?.other?.["official-artwork"]?.front_default || p.sprites?.front_default
    });
  } catch {
    res.status(404).json({ error: `Pokémon not found: ${req.params.name}` });
  }
});

app.get("/ask", async (req, res) => {
  const q = String(req.query.q || "");
  const intent = routeIntent(q);
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const oxford = (arr, conj = "and") => arr.length<=1?arr.join(""):arr.length===2?arr.join(` ${conj} `):`${arr.slice(0,-1).join(", ")}, ${conj} ${arr[arr.length-1]}`;
  const fmtMult = m => Number.isInteger(m) ? `×${m}` : `×${m.toFixed(2)}`;

  try {
    if (intent.intent === "move") {
      const move = await cachedJSON(`${API}/move/${encodeURIComponent(intent.move)}`);
      const parts = [];
      if (move.type?.name) parts.push(`${cap(move.type.name)}-type`);
      if (move.damage_class?.name) parts.push(`${move.damage_class.name} move`);
      const line1 = `${cap(move.name)} is a ${parts.join(" ")}.`;
      const line2 = [move.power ? `Power ${move.power}` : null, move.accuracy ? `Accuracy ${move.accuracy}` : null, move.pp ? `${move.pp} PP` : null].filter(Boolean).join(" • ");
      const effect = move.effect_entries?.[0]?.short_effect?.replace(/\$effect_chance/g, move.effect_chance ?? "") || "";
      return res.send([line1, line2, effect].filter(Boolean).join("\n"));
    }

    if (intent.intent === "compare_speed") {
      const [pa, pb] = await Promise.all([getPokemon(intent.a), getPokemon(intent.b)]);
      const sa = pa.stats.find(s => s.stat.name === "speed").base_stat;
      const sb = pb.stats.find(s => s.stat.name === "speed").base_stat;
      const A = cap(pa.name), B = cap(pb.name);
      if (sa === sb) return res.send(`${A} and ${B} tie in Speed (${sa}).`);
      return res.send(sa > sb ? `${A} is faster than ${B} (${sa} vs ${sb}).` : `${B} is faster than ${A} (${sb} vs ${sa}).`);
    }

    const p = await getPokemon(intent.name);
    const name = cap(p.name);

    if (intent.intent === "types") {
      const types = p.types.map(t => cap(t.type.name));
      return res.send(`${name} is ${oxford(types, "and")} type.`);
    }

    if (intent.intent === "stats") {
      const s = Object.fromEntries(p.stats.map(x => [x.stat.name, x.base_stat]));
      return res.send(`${name}'s base stats — HP ${s.hp}, Atk ${s.attack}, Def ${s.defense}, SpA ${s["special-attack"]}, SpD ${s["special-defense"]}, Spe ${s.speed}.`);
    }

    if (intent.intent === "weaknesses") {
      const wr = await weaknessesForPokemon(p);
      const w = wr.weaknesses.map(([t,m]) => `${cap(t)} (${fmtMult(m)})`);
      const r = wr.resistances.map(([t,m]) => `${cap(t)} (${fmtMult(m)})`);
      const i = wr.immunities.map(([t]) => cap(t));
      const parts = [];
      parts.push(w.length ? `Weak to ${oxford(w)}.` : `${name} has no notable weaknesses.`);
      if (r.length) parts.push(`Resists ${oxford(r)}.`);
      if (i.length) parts.push(`Immune to ${oxford(i)}.`);
      return res.send(parts.join(" "));
    }

    if (intent.intent === "evolution") {
      const species = await getSpecies(p.name);
      const chain = await getEvolutionChainByUrl(species.evolution_chain.url);
      const lines = flattenChain(chain).map(arr => arr.map(cap).join(" → "));
      const unique = [...new Set(lines)];
      return res.send(unique.length ? `${name}'s evolution line: ${unique.join(" | ")}.` : `${name} does not evolve.`);
    }

    const types = p.types.map(t => cap(t.type.name));
    const abilities = p.abilities.map(a => cap(a.ability.name));
    return res.send(`${name} (#${p.id}) is ${oxford(types, "and")} type. Abilities: ${oxford(abilities)}. Height ${p.height}, weight ${p.weight}.`);
  } catch (e) {
    return res.status(400).send(`Sorry, I couldn't answer that. ${e.message}`);
  }
});

app.listen(PORT, () => console.log(`Pokédex bot listening on port ${PORT}`));
