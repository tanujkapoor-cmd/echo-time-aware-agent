import assert from "node:assert/strict";
import test from "node:test";
import { databaseFile, draft, harness, hit, plan, price, send, session } from "./harness.ts";

// These are controlled historical fixtures. Product names and domains are real. Prices, dates and release text are test data.
test("a vendor shortlist survives a restart and retains pricing scope during a recheck", async () => {
  const fixture = harness("2026-11-02T17:00:00Z");
  const db = await databaseFile();
  const initial = [
    price("HubSpot", "Starter", 20, "https://www.hubspot.com/pricing", "seat"),
    price("Salesforce", "Starter Suite", 25, "https://www.salesforce.com/sales/pricing/", "seat"),
    price("Pipedrive", "Lite", 18, "https://www.pipedrive.com/en/pricing", "seat"),
    price("Zoho CRM", "Standard", 20, "https://www.zoho.com/crm/zohocrm-pricing.html", "seat"),
    price("Freshsales", "Growth", 15, "https://www.freshworks.com/crm/sales/pricing/", "seat"),
  ];
  const products = initial.map(entry => entry.subject);
  const team = "On Monday we picked five CRM options for our sales team of 20.";
  const setup = team + " Search the web for the monthly prices of " + products.join(", ") + ".";
  const previousQueries = ["HubSpot Salesforce Pipedrive official CRM pricing", "Zoho CRM Freshsales official pricing"];
  fixture.plans.push(plan(previousQueries[0], previousQueries[1]));
  fixture.searches.set(previousQueries[0], initial.slice(0, 3).map(entry => entry.source));
  fixture.searches.set(previousQueries[1], initial.slice(3).map(entry => entry.source));
  fixture.results.push(draft(initial));
  let app = await fixture.open(db);
  const earlier = await session(app);
  const old = await send(app, earlier.id, setup, "America/New_York");
  assert.equal(old.citations.length, 5);
  assert.equal(old.timing.search_calls, 2);
  assert.equal(old.timestamp, "2026-11-02T17:00:00.000Z");
  await app.close();

  fixture.at("2026-11-05T16:00:00Z");
  app = await fixture.open(db);
  try {
    const current = [
      price("HubSpot", "Starter", 23, initial[0].source.url, "seat"),
      initial[1],
      price("Pipedrive", "Lite", 14, initial[2].source.url, "seat", "annual"),
      initial[3],
      initial[4],
    ];
    const update = { subject: "HubSpot", attribute: "workflow update", value: "workflow approvals",
      source: hit("HubSpot product release", "https://www.hubspot.com/product-updates/workflow-approvals",
        "HubSpot added workflow approvals for sales teams.", "2026-11-04T12:00:00.000Z") };
    const conflict = price("Zoho CRM", "Standard", 23, "https://www.capterra.com/p/155928/Zoho-CRM/", "seat");
    const nextQueries = ["HubSpot Salesforce Pipedrive official CRM pricing new features", "Zoho CRM Freshsales pricing releases"];
    fixture.plans.push(plan(nextQueries[0], nextQueries[1]));
    fixture.searches.set(nextQueries[0], [...current.slice(0, 3), update].map(entry => entry.source));
    fixture.searches.set(nextQueries[1], [...current.slice(3), conflict].map(entry => entry.source));
    fixture.results.push(draft([...current.slice(0, 3), update, ...current.slice(3), conflict]));

    const followup = await session(app);
    const reply = await send(app, followup.id, "Has anything changed since we last checked?", "America/New_York");
    assert.equal(reply.baseline_at, old.timestamp);
    assert.equal(reply.memory_used, true);
    assert.deepEqual(fixture.calls.search.slice(-2), nextQueries);
    const planner = JSON.stringify(fixture.calls.plans.at(-1));
    for (const product of products) assert(planner.includes(product));
    assert(planner.includes(team));
    const changes = reply.changes.map(change => [change.subject, change.kind]);
    assert(changes.some(([subject, kind]) => subject === "HubSpot" && kind === "changed"));
    assert(changes.some(([subject, kind]) => subject === "HubSpot" && kind === "new"));
    assert(changes.some(([subject, kind]) => subject === "Zoho CRM" && kind === "conflicting"));
    assert(!changes.some(([subject, kind]) => subject === "Pipedrive" && kind === "changed"));
    assert.match(reply.answer, /\[H\d+\] \[S\d+\]/);
    assert.match(reply.answer, /2 Nov 2026/);
    assert.equal(reply.citations.find(source => source.url === update.source.url)?.published_at, update.source.published_at);
  } finally { await app.close(); }
});

test("an explicit date finds the earlier turn in the user's timezone after restart", async () => {
  const fixture = harness("2026-11-04T06:40:00Z"); // Nov 3, 22:40 in Los Angeles.
  const db = await databaseFile();
  const version = { subject: "Python", attribute: "stable version", value: "3.14.2",
    source: hit("Python downloads", "https://www.python.org/downloads/", "The latest stable Python version is 3.14.2.") };
  const query = "official Python latest stable version";
  fixture.plans.push(plan(query));
  fixture.searches.set(query, [version.source]);
  fixture.results.push(draft([version]));
  let app = await fixture.open(db);
  const initial = await session(app);
  const question = "What is the latest stable Python version?";
  const earlier = await send(app, initial.id, question, "America/Los_Angeles");
  fixture.at("2026-11-04T09:15:00Z"); // Nov 4 locally, so this turn must be excluded.
  await send(app, initial.id, "Explain binary search.");
  await app.close();

  fixture.at("2026-11-11T18:00:00Z");
  app = await fixture.open(db);
  try {
    const current = await session(app);
    fixture.results.push(draft([version]));
    const reply = await send(app, current.id, "What did I ask on November 3? Is that answer still accurate?", "America/Los_Angeles");
    assert.match(reply.answer, /3 Nov 2026/);
    assert(reply.answer.includes(question));
    assert.match(reply.answer, /I replied:/);
    assert.match(reply.answer, /still shows 3\.14\.2/);
    assert.equal(reply.baseline_at, earlier.citations[0].retrieved_at);
    assert.equal(reply.citations.find(source => source.id === "H1")?.retrieved_at, earlier.citations[0].retrieved_at);
    assert.equal(reply.changes[0].kind, "unchanged");
    assert.equal(fixture.calls.search.length, 2);
    const absent = await send(app, current.id, "What did I ask you on 1 November? Is your answer still correct today?", "America/Los_Angeles");
    assert.match(absent.answer, /couldn’t find a matching saved question/);
    assert.equal(absent.web_search_used, false);
  } finally { await app.close(); }
});

test("a relative weekday retrieves the hosting discussion and compares matching plans", async () => {
  const fixture = harness("2026-11-10T23:45:00Z");
  const db = await databaseFile();
  const first = [
    price("Render", "Basic", 19, "https://render.com/pricing", "instance"),
    price("Neon", "Launch", 15, "https://neon.com/pricing", "project"),
  ];
  const oldQuery = "PostgreSQL hosting Render Neon official plan monthly pricing";
  fixture.plans.push(plan(oldQuery));
  fixture.searches.set(oldQuery, first.map(entry => entry.source));
  fixture.results.push(draft(first));
  let app = await fixture.open(db);
  const old = await session(app);
  const original = await send(app, old.id, "Compare current Postgres hosting prices for Render Basic and Neon Launch.", "America/New_York");
  await app.close();

  fixture.at("2026-11-16T18:00:00Z");
  app = await fixture.open(db);
  try {
    const other = await session(app);
    const current = [
      price("Render", "Basic", 22, first[0].source.url, "instance"),
      price("Neon", "Launch", 12, first[1].source.url, "project", "annual"),
    ];
    fixture.plans.push(plan(oldQuery));
    fixture.searches.set(oldQuery, current.map(entry => entry.source));
    fixture.results.push(draft(current));
    const reply = await send(app, other.id, "Recheck the Postgres hosting prices from last Tuesday. Has anything changed?", "America/New_York");
    assert.equal(reply.baseline_at, original.timestamp);
    assert.match(reply.answer, /10 Nov 2026/);
    assert.match(reply.answer, /Render Basic .* changed from 19 to 22/);
    assert.match(reply.answer, /Neon Launch .* comparable earlier evidence/);
    assert.equal(reply.changes.filter(item => item.kind === "changed").length, 1);
    assert.equal(reply.timing.search_calls, 1);
    assert(reply.citations.some(source => source.provenance === "historical"));
  } finally { await app.close(); }
});

test("a pricing recheck with conversational history alone reports the missing evidence", async () => {
  const fixture = harness("2026-11-10T23:00:00Z");
  const app = await fixture.open("sqlite:///:memory:");
  try {
    const one = await session(app);
    await send(app, one.id, "We decided to evaluate Render Basic for Postgres hosting.");
    fixture.at("2026-11-16T12:00:00Z");
    const current = price("Render", "Basic", 22, "https://render.com/pricing", "instance");
    fixture.plans.push(plan("Render Basic Postgres hosting prices"));
    fixture.searches.set("Render Basic Postgres hosting prices", [current.source]);
    fixture.results.push(draft([current]));
    const two = await session(app);
    const reply = await send(app, two.id, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    assert.match(reply.answer, /don’t have comparable evidence saved/);
    assert.equal(reply.changes[0].kind, "insufficient");
    assert.equal(reply.timing.search_calls, 1);
  } finally { await app.close(); }
});

test("a dated recheck of a general explanation does not search", async () => {
  const fixture = harness("2026-11-03T15:00:00Z");
  const app = await fixture.open("sqlite:///:memory:");
  try {
    const one = await session(app);
    fixture.drafts.push({ answer: "A prime has exactly two positive divisors.", memories: [] });
    await send(app, one.id, "What is a prime number?");
    fixture.at("2026-11-11T12:00:00Z");
    fixture.drafts.push({ answer: "That definition still holds.", memories: [] });
    const two = await session(app);
    const reply = await send(app, two.id, "What did I ask you on 3 November? Is your answer still correct today?");
    assert.match(reply.answer, /exactly two positive divisors/);
    assert.match(reply.answer, /still holds/);
    assert.equal(reply.timing.search_calls, 0);
  } finally { await app.close(); }
});
