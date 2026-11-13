import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare } = runtimeRequire("miniflare")
const { build } = runtimeRequire("esbuild")
const dir = fileURLToPath(new URL(".", import.meta.url))
const dependencyRoot = process.env.NOTES_TIME_DEPS ?? "/private/tmp/kipp-notes-time-spike/node_modules"
const dependencyRequire = createRequire(join(dependencyRoot, "../package.json"))

const cases = [
  ["Kolkata", "2026-07-28", "19:00", "Asia/Kolkata", "unique", ["2026-07-28T13:30:00.000Z"]],
  ["invalid date", "2026-02-30", "12:00", "Asia/Kolkata", "invalid", []],
  ["invalid zone", "2026-07-28", "19:00", "Invalid/Zone", "invalid", []],
  ["invalid time", "2026-07-28", "24:00", "Asia/Kolkata", "invalid", []],
  ["NY gap", "2026-03-08", "02:30", "America/New_York", "nonexistent", []],
  ["NY fold", "2026-11-01", "01:30", "America/New_York", "ambiguous", ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]],
  ["Lord Howe gap", "2026-10-04", "02:15", "Australia/Lord_Howe", "nonexistent", []],
  ["Lord Howe fold", "2026-04-05", "01:45", "Australia/Lord_Howe", "ambiguous", ["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"]],
]
const checks = `
  const cases = ${JSON.stringify(cases)};
  const output = cases.map(([name,date,time,zone]) => ({name, ...adapter.resolve(date,time,zone)}));
  const lengths = [
    ["NY short day","2026-03-08","America/New_York"],
    ["NY long day","2026-11-01","America/New_York"],
    ["midnight gap","2018-11-04","America/Sao_Paulo"],
    ["Kolkata day","2026-07-28","Asia/Kolkata"]
  ].map(([name,date,zone]) => { const bounds = adapter.bounds(date,zone); return {name, bounds, hours:(Date.parse(bounds[1])-Date.parse(bounds[0]))/3600000}; });
  const dates = [adapter.add("2026-03-07",1), adapter.add("2026-12-31",1), adapter.add("2024-02-28",1)];
  const recurring = [0,7,14].map(days => {const date=adapter.add("2026-03-01",days); return {date,...adapter.resolve(date,"09:00","America/New_York")};});
  let skipped; try { adapter.bounds("2011-12-30","Pacific/Apia"); skipped=false; } catch { skipped=true; }
  let beforeSkippedDay; try { const bounds=adapter.bounds("2011-12-29","Pacific/Apia"); beforeSkippedDay={bounds,hours:(Date.parse(bounds[1])-Date.parse(bounds[0]))/3600000}; } catch { beforeSkippedDay={error:"cannot compute next-day boundary"}; }
  return Response.json({output,lengths,dates,recurring,skipped,beforeSkippedDay,nativeTemporal:typeof globalThis.Temporal});
`

const report = { versions: {}, results: {} }
for (const name of ["luxon", "@js-temporal/polyfill", "miniflare", "workerd", "esbuild"]) {
  const resolver = ["luxon", "@js-temporal/polyfill"].includes(name) ? dependencyRequire : runtimeRequire
  let entry = resolver.resolve(name)
  while (true) {
    const path = join(entry, "../package.json")
    try { const pkg = JSON.parse(await readFile(path,"utf8")); if (pkg.name === name) {report.versions[name]=pkg.version;break;} } catch {}
    const parent = resolve(entry,"..")
    if (parent === entry) throw Error(`Cannot resolve package version: ${name}`)
    entry = parent
  }
}
report.versions.node = process.version
for (const name of ["intl","luxon","temporal"]) {
  const {outputFiles} = await build({stdin:{contents:`import { ${name} as adapter } from ${JSON.stringify(join(dir,"adapters.mjs"))}; export default {fetch(){ ${checks} }}`,resolveDir:dir,loader:"js"},bundle:true,write:false,format:"esm",target:"es2022",minify:true,nodePaths:[dependencyRoot]})
  const code = outputFiles[0].text
  const runtime = new Miniflare({modules:true,script:code,compatibilityDate:"2026-07-08"})
  try {
    const started = performance.now()
    const response = await runtime.dispatchFetch("http://probe/")
    const body = await response.json()
    assert.equal(response.status,200)
    for (let i=0;i<cases.length;i++) {
      assert.equal(body.output[i].kind,cases[i][4],`${name}: ${cases[i][0]}`)
      assert.deepEqual(body.output[i].instants,cases[i][5],`${name}: ${cases[i][0]}`)
    }
    assert.deepEqual(body.lengths.map(x=>x.hours),[23,25,23,24])
    assert.deepEqual(body.dates,["2026-03-08","2027-01-01","2024-02-29"])
    assert.deepEqual(body.recurring.map(x=>x.instants[0]),["2026-03-01T14:00:00.000Z","2026-03-08T13:00:00.000Z","2026-03-15T13:00:00.000Z"])
    assert.equal(body.skipped,true)
    if (name === "intl") assert.equal(body.beforeSkippedDay.error,"cannot compute next-day boundary")
    else assert.equal(body.beforeSkippedDay.hours,24)
    report.results[name]={minifiedBytes:Buffer.byteLength(code),gzipBytes:gzipSync(code).length,elapsedIncludingRuntimeStartMs:Math.round(performance.now()-started),...body}
    console.log(`${name}: all 19 checks passed; minified ${Buffer.byteLength(code)}, gzip ${gzipSync(code).length} bytes`)
  } finally {await runtime.dispose()}
}
const baselineSource = `import {zonedDateTimeToMillis,calendarDayBounds} from ${JSON.stringify(resolve(dir,"../../../src/calendar/scheduling.ts"))}; export default { fetch(){
  let invalidZone; try {zonedDateTimeToMillis("2026-07-28","19:00","Invalid/Zone");invalidZone="accepted";} catch {invalidZone="throws";}
  return Response.json({overlapChosen:new Date(zonedDateTimeToMillis("2026-11-01","01:30","America/New_York")).toISOString(),gap:zonedDateTimeToMillis("2026-03-08","02:30","America/New_York"),midnightGapBounds:calendarDayBounds("2018-11-04","America/Sao_Paulo"),invalidZone}); }};`
const baselineBuild = await build({stdin:{contents:baselineSource,resolveDir:dir,loader:"js"},bundle:true,write:false,format:"esm",target:"es2022",minify:true})
const baseline = new Miniflare({modules:true,script:baselineBuild.outputFiles[0].text,compatibilityDate:"2026-07-08"})
try {
  report.currentCalendar = await (await baseline.dispatchFetch("http://probe/")).json()
  assert.equal(report.currentCalendar.overlapChosen,"2026-11-01T05:30:00.000Z")
  assert.equal(report.currentCalendar.gap,null)
  assert.equal(report.currentCalendar.midnightGapBounds,null)
  assert.equal(report.currentCalendar.invalidZone,"throws")
  console.log("Current Calendar: reproduced silent overlap selection, midnight-gap rejection, invalid-zone throw")
} finally {await baseline.dispose()}
await writeFile(join(dir,"results.json"),JSON.stringify(report,null,2)+"\n")
console.log("Saved tools/spikes/notes-time/results.json")
