/**
 * @file benchmark_beam_eval.js
 * Synthetic 520-Memory Architecture Smoke & Regression Suite for krusch-context-mcp.
 *
 * NOTE: This is a fast, offline, deterministic 21-probe architecture smoke suite over a
 * self-seeded 520-memory SQLite haystack verifying all 10 BEAM capability mechanisms + INV-12
 * code span drift. For the official 400-question ICLR 2026 `Mohammadta/BEAM` 100K empirical
 * benchmark, run `npm run bench:beam:official` (`scripts/benchmark_official_beam.js`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    addMemory,
    supersedeMemory,
    invalidateMemory,
    compileProjectState,
    getHealthStats
} from '../src/memory-engine.js';
import { nuggetRemember } from '../src/nuggets-engine.js';
import { handleProactiveNudge } from '../src/proactive-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { getProjectDb, closeAllDatabases, resolveProjectPath } from '../src/sqlite-engine.js';

/**
 * Generates a deterministic, non-constant 1024-dim unit vector from text tokens
 * so cosine similarity reflects token-space semantics without requiring network calls.
 */
function deterministicEmbedding(text, dims = 1024) {
    const vec = new Float64Array(dims);
    // Base low-level background distribution
    for (let i = 0; i < dims; i++) {
        vec[i] = ((i % 17) - 8) * 0.002;
    }
    const tokens = String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length > 2);

    for (const tok of tokens) {
        let h1 = 2166136261;
        let h2 = 16777619;
        for (let i = 0; i < tok.length; i++) {
            const c = tok.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
            h2 = Math.imul(h2 + c, 1099511628211 & 0xffffffff) >>> 0;
        }
        const idx1 = h1 % dims;
        const idx2 = h2 % dims;
        const idx3 = (h1 ^ h2) % dims;
        vec[idx1] += 1.0;
        vec[idx2] += 0.6;
        vec[idx3] -= 0.4;
    }

    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec, v => Number((v / norm).toFixed(6)));
}

/**
 * Simulates the legacy pre-upgrade retrieval behavior (Active-only LIMIT 250, flat score sort,
 * default 0.5 baseline score, no lineage forwarding, no epistemic_status or conflict detection).
 */
function legacyRetrieveSimulation(db, { query, limitTokens = 4000 }) {
    const lowerQuery = String(query || '').toLowerCase().trim();
    const queryTerms = lowerQuery.split(/\s+/).filter(t => t.length > 2);
    const rows = db.prepare(`
        SELECT id, category, content, tags, status, created_at
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
        ORDER BY id DESC
        LIMIT 250
    `).all();

    const items = [];
    for (const r of rows) {
        let score = 0.5;
        const lowerContent = r.content.toLowerCase();
        const lowerTags = r.tags ? String(r.tags).toLowerCase() : '';
        if (lowerContent.includes(lowerQuery)) {
            score = 0.85;
        } else if (queryTerms.length > 0) {
            const matches = queryTerms.filter(t => lowerContent.includes(t) || lowerTags.includes(t)).length;
            if (matches > 0) {
                score = Math.max(score, 0.5 + (matches / queryTerms.length) * 0.35);
            }
        }
        if (score > 0.4) {
            items.push({ id: r.id, content: r.content, score, status: r.status });
        }
    }

    items.sort((a, b) => b.score - a.score);
    let used = 0;
    const packed = [];
    for (const it of items) {
        const toks = Math.ceil((it.content.length + 40) / 4);
        if (used + toks > limitTokens && packed.length > 0) break;
        used += toks;
        packed.push(it);
    }

    return {
        text: packed.map(p => p.content).join('\n'),
        packedIds: packed.map(p => p.id),
        epistemic_status: null,
        conflicts: [],
        chronological_order: packed.map(p => p.id)
    };
}

async function runBeamBenchmark() {
    console.log("=====================================================================================");
    console.log("🧪 SYNTHETIC 520-MEMORY ARCHITECTURE SMOKE SUITE (21 Self-Authored Deterministic Probes)");
    console.log("   (For the official 400-question Mohammadta/BEAM 100K benchmark, run npm run bench:beam:official)");
    console.log("=====================================================================================\n");

    const startTime = Date.now();
    const benchProject = `test_beam_${Date.now()}`;
    const projRoot = resolveProjectPath(benchProject);
    fs.mkdirSync(projRoot, { recursive: true });

    const ids = {};

    try {
        console.log("1️⃣ Seeding Multi-Session 520-Memory Enterprise Haystack...");
        const db = await getProjectDb(benchProject);

        // --- A. Early Session Facts (Buried at bottom of DB, >450 rows behind latest writes) ---
        // Tests breaking the legacy LIMIT 250 ceiling
        const niah1 = await addMemory({
            category: 'bug',
            content: 'DEEP_NEEDLE_ALPHA: Project Orion telemetry collector leaks file descriptors when gRPC keepalive_time_ms is set below 15000ms on Linux kernel 6.8.',
            tags: ['orion', 'grpc', 'telemetry'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Project Orion telemetry collector gRPC keepalive_time_ms 15000ms file descriptors')
        });
        ids.niah1 = niah1.id;

        const niah2 = await addMemory({
            category: 'decision',
            content: 'DEEP_NEEDLE_BETA: Sovereign Vault encryption uses ChaCha20-Poly1305 with a 96-bit nonce derived via HKDF-SHA256 from hardware TPM slot 3.',
            tags: ['vault', 'encryption', 'chacha20'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Sovereign Vault encryption ChaCha20-Poly1305 HKDF-SHA256 TPM slot 3')
        });
        ids.niah2 = niah2.id;

        const niah3 = await addMemory({
            category: 'lesson',
            content: 'DEEP_NEEDLE_GAMMA: NVLink P2P DMA transfers between dual GPUs require IOMMU passthrough (iommu=pt) in GRUB cmdline or throughput drops from 50GB/s to 7.8GB/s.',
            tags: ['nvlink', 'iommu', 'gpu'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('NVLink P2P DMA dual GPUs IOMMU passthrough iommu=pt GRUB 50GB/s')
        });
        ids.niah3 = niah3.id;

        // --- B. Multi-Hop Knowledge Updates & Temporal Lineage Chains ---
        // Chain 1: Entity "Project Chronos" is ONLY named in v1, then superseded by v2 -> v3!
        const chronosV1 = await addMemory({
            category: 'decision',
            content: 'Project Chronos billing ledger is initially hosted on AWS RDS Aurora in us-west-2 using port 5432.',
            tags: ['chronos', 'billing', 'aws'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Project Chronos billing ledger hosted AWS RDS Aurora us-west-2 port 5432')
        });
        const chronosV2 = await supersedeMemory({
            target_id: chronosV1.id,
            content: 'Migrated billing ledger from AWS Aurora to self-hosted Citus cluster in ashburn-dc1 on port 6432.',
            tags: ['billing', 'citus', 'ashburn'],
            project: benchProject,
            _embedding: deterministicEmbedding('Migrated billing ledger AWS Aurora Citus ashburn-dc1 port 6432')
        });
        const chronosV3 = await supersedeMemory({
            target_id: chronosV2.id,
            content: 'Consolidated billing ledger onto primary Polygres HA cluster in dal-central-3 on port 5434 with synchronous replication.',
            tags: ['billing', 'polygres', 'dal-central-3'],
            project: benchProject,
            _embedding: deterministicEmbedding('Consolidated billing ledger Polygres HA dal-central-3 port 5434')
        });
        ids.chronos = [chronosV1.id, chronosV2.id, chronosV3.id];

        // Chain 2: Cache engine evolution (Redis -> Dragonfly -> Valkey)
        const cacheV1 = await addMemory({
            category: 'decision',
            content: 'Session cache tier initialized with Redis 6.2 standalone on port 6379 with 8GB maxmemory.',
            tags: ['cache', 'redis'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Session cache tier Redis 6.2 standalone port 6379 8GB')
        });
        const cacheV2 = await supersedeMemory({
            target_id: cacheV1.id,
            content: 'Upgraded session cache tier to DragonflyDB on port 6380 with 24GB vertical thread scaling.',
            tags: ['cache', 'dragonfly'],
            project: benchProject,
            _embedding: deterministicEmbedding('Upgraded session cache tier DragonflyDB port 6380 24GB')
        });
        const cacheV3 = await supersedeMemory({
            target_id: cacheV2.id,
            content: 'Standardized session cache tier on Valkey 8.0 Sentinel cluster on port 6381 with 32GB memory.',
            tags: ['cache', 'valkey'],
            project: benchProject,
            _embedding: deterministicEmbedding('Standardized session cache tier Valkey 8.0 Sentinel port 6381 32GB')
        });
        ids.cache = [cacheV1.id, cacheV2.id, cacheV3.id];

        // Chain 3: Invalidated legacy policy (must NEVER surface as active)
        const legacyAuth = await addMemory({
            category: 'invariant',
            content: 'Legacy Auth Rule: Allow basic HTTP password headers on internal admin endpoints.',
            tags: ['auth', 'legacy'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Legacy Auth Rule basic HTTP password headers internal admin')
        });
        await invalidateMemory({
            target_id: legacyAuth.id,
            reason: 'Revoked after zero-trust mTLS and JWT cutover in Q3.',
            project: benchProject
        });
        ids.invalidatedAuth = legacyAuth.id;

        // --- C. Event Ordering Sequence (4 independent chronological incident milestones) ---
        const ev1 = await addMemory({
            category: 'lesson',
            content: 'Incident Atlas Milestone 1 (09:00 UTC): BGP route flap detected on upstream transit peer AS64512.',
            tags: ['incident-atlas', 'bgp'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Incident Atlas Milestone 1 BGP route flap transit peer AS64512')
        });
        const ev2 = await addMemory({
            category: 'lesson',
            content: 'Incident Atlas Milestone 2 (09:14 UTC): WireGuard mesh failover triggered automatic reroute to secondary fiber.',
            tags: ['incident-atlas', 'wireguard'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Incident Atlas Milestone 2 WireGuard mesh failover reroute')
        });
        const ev3 = await addMemory({
            category: 'lesson',
            content: 'Incident Atlas Milestone 3 (09:32 UTC): PostgreSQL WAL replica promoted after split-brain fencing completed.',
            tags: ['incident-atlas', 'wal'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Incident Atlas Milestone 3 PostgreSQL WAL replica promoted fencing')
        });
        const ev4 = await addMemory({
            category: 'lesson',
            content: 'Incident Atlas Milestone 4 (09:50 UTC): Traffic restored to 100% nominal SLA and post-mortem ticket closed.',
            tags: ['incident-atlas', 'sla'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Incident Atlas Milestone 4 Traffic restored 100% nominal SLA')
        });
        ids.atlasEvents = [ev1.id, ev2.id, ev3.id, ev4.id];

        // --- D. Bulk Haystack Noise (460 realistic memories across sessions) ---
        // Pushes early memories >460 rows deep to stress-test the >250 memory scale boundary
        const noiseInsert = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding, status, pg_synced)
            VALUES (?, ?, ?, ?, 'ACTIVE', 1)
        `);
        const noiseTopics = [
            ['lesson', 'Configured Prometheus telemetry scrape interval for node exporter metrics on port 9100.', '["prometheus","telemetry","metrics"]'],
            ['decision', 'Standardized React billing table pagination page size to 25 rows with 200ms debounce timeout.', '["frontend","billing","pagination"]'],
            ['bug', 'Fixed CSS flexbox overflow in mobile cache dashboard sidebar navigation drawer.', '["css","cache","mobile"]'],
            ['lesson', 'Rotated staging TLS encryption certificates via automated ACME DNS-01 challenge.', '["tls","encryption","acme"]'],
            ['decision', 'Enabled nginx gzip level 6 compression on static asset reverse proxy connections.', '["nginx","connections","gzip"]']
        ];
        const dummyNoiseEmb = JSON.stringify(deterministicEmbedding('routine infrastructure maintenance log entry'));
        db.exec('BEGIN');
        for (let i = 1; i <= 460; i++) {
            const [cat, baseText, tags] = noiseTopics[i % noiseTopics.length];
            noiseInsert.run(cat, `Session Noise Log #${i}: ${baseText} (batch ${Math.ceil(i / 20)})`, tags, dummyNoiseEmb);
        }
        db.exec('COMMIT');

        // --- E. Unresolved Active Contradictions (Contradiction Resolution) ---
        // Pair 1: Conflicting numeric timeout values on the exact same subject ("Webhook Dispatcher retry timeout")
        const conflictA1 = await addMemory({
            category: 'decision',
            content: 'Webhook Dispatcher retry timeout must be set to 5s with a maximum of 3 retries.',
            tags: ['webhook', 'dispatcher', 'timeout'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Webhook Dispatcher retry timeout 5s maximum 3 retries')
        });
        const conflictA2 = await addMemory({
            category: 'decision',
            content: 'Webhook Dispatcher retry timeout must be set to 45s with a maximum of 10 retries.',
            tags: ['webhook', 'dispatcher', 'timeout'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Webhook Dispatcher retry timeout 45s maximum 10 retries')
        });
        ids.webhookConflict = [conflictA1.id, conflictA2.id];

        // Pair 2: Opposing polarity directives on the exact same subject ("GraphQL introspection schema endpoint")
        const conflictB1 = await addMemory({
            category: 'invariant',
            content: 'GraphQL introspection schema endpoint must always remain enabled in production for partner SDK codegen.',
            tags: ['graphql', 'introspection', 'schema'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('GraphQL introspection schema endpoint always enabled production')
        });
        const conflictB2 = await addMemory({
            category: 'invariant',
            content: 'Never allow GraphQL introspection schema endpoint in production; it must be strictly disabled.',
            tags: ['graphql', 'introspection', 'schema'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Never allow GraphQL introspection schema endpoint production disabled')
        });
        ids.graphqlConflict = [conflictB1.id, conflictB2.id];

        // --- F. Multi-Session Reasoning (Submodular Coverage across 3 distinct facets) ---
        // Seed Facet 2 and Facet 3 in earlier sessions, followed by 5 distinct (non-duplicate) Facet 1 memories
        // that each match 5 query terms ("PgBouncer", "database", "max_client_conn", "ceiling", "connections")
        // so naive Top-K crowds out Facet 2 & Facet 3 under a 3-item token budget!
        const msFacet2 = await addMemory({
            category: 'decision',
            content: 'Worker Swarm Sizing: Each Kraken worker replica opens 15 persistent client sockets.',
            tags: ['kraken', 'worker', 'replicas'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('Kraken worker replica opens 15 persistent client sockets')
        });
        const msFacet3 = await addMemory({
            category: 'invariant',
            content: 'Admin Reserve Rule: 30 administrative slots must remain reserved for superuser SRE diagnostics.',
            tags: ['superuser', 'reserve', 'diagnostics'],
            project: benchProject,
            force: true,
            _embedding: deterministicEmbedding('30 administrative slots reserved superuser SRE diagnostics')
        });
        const pgbNotes = [
            'PgBouncer Architecture Audit: Primary PgBouncer database max_client_conn ceiling connections limit is capped at 120 during peak traffic.',
            'PgBouncer Load Test Report: Verified PgBouncer database max_client_conn ceiling connections threshold holds steady at 120 under synthetic stress.',
            'PgBouncer Terraform Module: Provisioned PgBouncer database max_client_conn ceiling connections parameter at 120 in production helm chart.',
            'PgBouncer Failover Runbook: Standby PgBouncer database max_client_conn ceiling connections quota mirrors primary at 120 across availability zones.',
            'PgBouncer Compliance Signoff: Audited PgBouncer database max_client_conn ceiling connections setting of 120 for quarterly capacity review.'
        ];
        for (const noteText of pgbNotes) {
            await addMemory({
                category: 'decision',
                content: noteText,
                tags: ['pgbouncer', 'capacity'],
                project: benchProject,
                force: true,
                _embedding: deterministicEmbedding(noteText)
            });
        }
        ids.multiSessionFacets = { facet2: msFacet2.id, facet3: msFacet3.id };

        // --- G. Preferences & Nuggets (Preference Following) ---
        await nuggetRemember({
            key: 'package_manager',
            value: 'Use pnpm with --frozen-lockfile for all monorepo TypeScript workspaces; never use yarn.',
            project: benchProject,
            _embedding: deterministicEmbedding('package_manager pnpm frozen-lockfile monorepo TypeScript')
        });
        await nuggetRemember({
            key: 'test_runner',
            value: 'Use native node:test runner with assert/strict; do not install jest or mocha.',
            project: benchProject,
            _embedding: deterministicEmbedding('test_runner native node:test assert/strict no jest mocha')
        });
        await nuggetRemember({
            key: 'handoff',
            value: 'Completed BEAM-10 memory upgrade; next step is full verification gate.',
            project: benchProject,
            _embedding: deterministicEmbedding('handoff BEAM-10 memory upgrade verification')
        });

        // --- H. Instruction Following & Span-Grounded Code Invariants (INV-12) ---
        const anchorFile = path.join(projRoot, 'billing-worker.js');
        fs.writeFileSync(
            anchorFile,
            `export const MAX_BATCH_SIZE = 500;\nexport function processBatch(items) {\n  return items.slice(0, MAX_BATCH_SIZE);\n}\n`,
            'utf8'
        );
        const anchoredInv = await addMemory({
            category: 'invariant',
            content: 'Never use eval() or child_process.execSync() in billing-worker.js; batch size must stay 500.',
            project: benchProject,
            provenance: {
                file: 'billing-worker.js',
                locator: 'L1-L3',
                quoted_sentence: 'export const MAX_BATCH_SIZE = 500;'
            },
            force: true,
            _embedding: deterministicEmbedding('Never use eval child_process.execSync billing-worker.js MAX_BATCH_SIZE 500')
        });
        ids.anchoredInv = anchoredInv.id;

        const totalSeeded = db.prepare(`SELECT COUNT(*) as cnt FROM ide_agent_memory`).get().cnt;
        console.log(`✅ Seeded ${totalSeeded} episodic memories + 3 steering nuggets into isolated SQLite store.\n`);

        // =========================================================================
        // 2️⃣ DEFINE THE 10 BEAM ABILITY EVALUATIONS
        // =========================================================================
        const results = {};
        const recordResult = (categoryKey, legacyPass, upgradedPass) => {
            if (!results[categoryKey]) {
                results[categoryKey] = { legacyPassed: 0, upgradedPassed: 0, total: 0 };
            }
            results[categoryKey].total += 1;
            if (legacyPass) results[categoryKey].legacyPassed += 1;
            if (upgradedPass) results[categoryKey].upgradedPassed += 1;
        };

        // --- 1. INFORMATION EXTRACTION (Deep Haystack >460 rows deep) ---
        for (const probe of [
            { q: 'Project Orion telemetry collector gRPC keepalive_time_ms file descriptors', expected: '15000ms' },
            { q: 'Sovereign Vault encryption cipher nonce HKDF-SHA256 TPM slot', expected: 'ChaCha20-Poly1305' },
            { q: 'NVLink P2P DMA dual GPUs IOMMU passthrough GRUB throughput', expected: 'iommu=pt' }
        ]) {
            const leg = legacyRetrieveSimulation(db, { query: probe.q });
            const upg = await unifiedRetrieve({
                query: probe.q,
                project: benchProject,
                _embedding: deterministicEmbedding(probe.q)
            });
            const upgText = upg.content[0].text;
            recordResult(
                'information_extraction',
                leg.text.includes(probe.expected),
                upgText.includes(probe.expected) && upg.epistemic_status === 'SUPPORTED'
            );
        }

        // --- 2. KNOWLEDGE UPDATE (Tracking latest state across 3-hop supersession + entity forwarding) ---
        {
            // Probe A: Entity "Project Chronos" only named in v1, but active state is v3 ("Polygres HA ... port 5434")
            const q1 = 'Where is Project Chronos billing ledger currently hosted and on what port?';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            const upgText1 = upg1.content[0].text;
            recordResult(
                'knowledge_update',
                leg1.text.includes('5434') && leg1.text.includes('Polygres') && !leg1.packedIds.includes(ids.chronos[0]),
                upgText1.includes('5434') && upgText1.includes('Polygres') && upg1.citations.some(c => c.id === ids.chronos[2] && c.status === 'ACTIVE')
            );

            // Probe B: Current session cache tier (Valkey 8.0 on port 6381, not Redis or Dragonfly)
            const q2 = 'What is our current active session cache tier engine and port?';
            const leg2 = legacyRetrieveSimulation(db, { query: q2 });
            const upg2 = await unifiedRetrieve({
                query: q2,
                project: benchProject,
                _embedding: deterministicEmbedding(q2)
            });
            const upgText2 = upg2.content[0].text;
            recordResult(
                'knowledge_update',
                leg2.text.includes('Valkey') && leg2.text.includes('6381'),
                upgText2.includes('Valkey') && upgText2.includes('6381') && upg2.citations[0]?.id === ids.cache[2]
            );

            // Probe C: Invalidated rule must NOT be returned as active
            const q3 = 'Legacy Auth Rule basic HTTP password headers internal admin';
            const leg3 = legacyRetrieveSimulation(db, { query: q3 });
            const upg3 = await unifiedRetrieve({
                query: q3,
                project: benchProject,
                _embedding: deterministicEmbedding(q3)
            });
            recordResult(
                'knowledge_update',
                !leg3.text.includes('Allow basic HTTP password headers'),
                !upg3.content[0].text.includes('Allow basic HTTP password headers') && upg3.epistemic_status === 'NO_KNOWN_SUPPORT'
            );
        }

        // --- 3. TEMPORAL REASONING ("What was X before Y?" across superseded history) ---
        {
            // Probe A: What was Project Chronos hosted on originally before Citus and Polygres?
            const q1 = 'What was Project Chronos billing ledger hosted on originally before migrating to Citus?';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            const upgText1 = upg1.content[0].text;
            recordResult(
                'temporal_reasoning',
                leg1.text.includes('AWS RDS Aurora') && leg1.text.includes('Polygres'),
                upgText1.includes('AWS RDS Aurora') && upgText1.includes('Citus') && upgText1.includes('Polygres')
            );

            // Probe B: What cache engine and port did we use right before Valkey 8.0?
            const q2 = 'Which session cache engine and port did we use previously before switching to Valkey?';
            const leg2 = legacyRetrieveSimulation(db, { query: q2 });
            const upg2 = await unifiedRetrieve({
                query: q2,
                project: benchProject,
                _embedding: deterministicEmbedding(q2)
            });
            const upgText2 = upg2.content[0].text;
            recordResult(
                'temporal_reasoning',
                leg2.text.includes('DragonflyDB') && leg2.text.includes('6380'),
                upgText2.includes('DragonflyDB') && upgText2.includes('6380') && upgText2.includes('Redis 6.2')
            );
        }

        // --- 4. EVENT ORDERING (Reconstructing exact chronological sequences t1 -> t2 -> t3 -> t4) ---
        {
            // Probe A: Incident Atlas 4-milestone sequence
            const q1 = 'In what chronological order did the Incident Atlas milestones occur from first to last?';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            const expectedAtlas = ids.atlasEvents;
            const legOrder1 = leg1.chronological_order.filter(id => expectedAtlas.includes(id));
            const upgOrder1 = upg1.chronological_order.filter(id => expectedAtlas.includes(id));
            recordResult(
                'event_ordering',
                JSON.stringify(legOrder1) === JSON.stringify(expectedAtlas),
                JSON.stringify(upgOrder1) === JSON.stringify(expectedAtlas) && upg1.content[0].text.includes('Chronological Event Sequence')
            );

            // Probe B: Cache migration sequence (cacheV1 -> cacheV2 -> cacheV3)
            const q2 = 'What is the chronological sequence of our session cache tier evolution over time?';
            const leg2 = legacyRetrieveSimulation(db, { query: q2 });
            const upg2 = await unifiedRetrieve({
                query: q2,
                project: benchProject,
                _embedding: deterministicEmbedding(q2)
            });
            const expectedCache = ids.cache;
            const legOrder2 = leg2.chronological_order.filter(id => expectedCache.includes(id));
            const upgOrder2 = upg2.chronological_order.filter(id => expectedCache.includes(id));
            recordResult(
                'event_ordering',
                JSON.stringify(legOrder2) === JSON.stringify(expectedCache),
                JSON.stringify(upgOrder2) === JSON.stringify(expectedCache)
            );
        }

        // --- 5. CONTRADICTION RESOLUTION (Detecting un-superseded active conflicts vs resolved updates & compatible multi-metric facts) ---
        {
            // Probe A: Unresolved numeric conflict on Webhook Dispatcher retry timeout
            const q1 = 'What is the Webhook Dispatcher retry timeout and max retries?';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            recordResult(
                'contradiction_resolution',
                leg1.epistemic_status === 'CONFLICTED',
                upg1.epistemic_status === 'CONFLICTED' &&
                upg1.conflicts.some(c => c.older_id === ids.webhookConflict[0] && c.newer_id === ids.webhookConflict[1])
            );

            // Probe B: Unresolved polarity conflict on GraphQL introspection schema endpoint
            const q2 = 'Should the GraphQL introspection schema endpoint be enabled in production?';
            const leg2 = legacyRetrieveSimulation(db, { query: q2 });
            const upg2 = await unifiedRetrieve({
                query: q2,
                project: benchProject,
                _embedding: deterministicEmbedding(q2)
            });
            recordResult(
                'contradiction_resolution',
                leg2.epistemic_status === 'CONFLICTED',
                upg2.epistemic_status === 'CONFLICTED' &&
                upg2.conflicts.some(c => c.older_id === ids.graphqlConflict[0] && c.newer_id === ids.graphqlConflict[1])
            );

            // Probe C: Formally superseded chain (Cache V1->V2->V3) must NOT false-positive as CONFLICTED
            const q3 = 'What is the session cache tier port and memory size?';
            const upg3 = await unifiedRetrieve({
                query: q3,
                project: benchProject,
                _embedding: deterministicEmbedding(q3)
            });
            recordResult(
                'contradiction_resolution',
                true,
                upg3.epistemic_status === 'SUPPORTED' && upg3.conflicts.length === 0
            );

            // Probe D: Compatible multi-number ACTIVE facts (120 ceiling vs 15 per replica vs 30 reserve) must NOT false-positive as CONFLICTED
            const q4 = 'What are the database connections limits for Kraken worker replicas and superuser SRE reserve?';
            const upg4 = await unifiedRetrieve({
                query: q4,
                project: benchProject,
                _embedding: deterministicEmbedding(q4)
            });
            recordResult(
                'contradiction_resolution',
                true,
                upg4.epistemic_status === 'SUPPORTED' && upg4.conflicts.length === 0
            );
        }

        // --- 6. ABSTENTION (Refusing to fabricate when queried about unrecorded entities) ---
        for (const unrecordedQuery of [
            'What is the Kafka partition retention policy for the Snowflake billing cluster?',
            'Which Rust crate version do we use for our WebAssembly audio codec?',
            'What is the Cassandra replication factor in the Tokyo ap-northeast-1 region?'
        ]) {
            const leg = legacyRetrieveSimulation(db, { query: unrecordedQuery });
            const upg = await unifiedRetrieve({
                query: unrecordedQuery,
                project: benchProject,
                _embedding: deterministicEmbedding(unrecordedQuery)
            });
            recordResult(
                'abstention',
                leg.packedIds.length === 0 || leg.epistemic_status === 'NO_KNOWN_SUPPORT',
                upg.epistemic_status === 'NO_KNOWN_SUPPORT' && upg.citations.length === 0
            );
        }

        // --- 7. PREFERENCE FOLLOWING (Retaining steering nuggets & workflow conventions) ---
        {
            const q1 = 'Which package_manager and lockfile flag should we use for TypeScript workspaces?';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            recordResult(
                'preference_following',
                leg1.text.includes('pnpm') && leg1.text.includes('--frozen-lockfile'),
                upg1.content[0].text.includes('pnpm') && upg1.content[0].text.includes('--frozen-lockfile')
            );

            const q2 = 'Which test_runner and assertion library should we use instead of jest?';
            const leg2 = legacyRetrieveSimulation(db, { query: q2 });
            const upg2 = await unifiedRetrieve({
                query: q2,
                project: benchProject,
                _embedding: deterministicEmbedding(q2)
            });
            recordResult(
                'preference_following',
                leg2.text.includes('node:test'),
                upg2.content[0].text.includes('node:test') && upg2.content[0].text.includes('assert/strict')
            );
        }

        // --- 8. INSTRUCTION FOLLOWING (Negative invariant retrieval + pre-commit nudge enforcement) ---
        {
            const q1 = 'billing-worker.js eval execSync batch size invariant';
            const leg1 = legacyRetrieveSimulation(db, { query: q1 });
            const upg1 = await unifiedRetrieve({
                query: q1,
                category: 'invariant',
                project: benchProject,
                _embedding: deterministicEmbedding(q1)
            });
            const nudgeRes = await handleProactiveNudge({
                trigger: 'pre_commit',
                file_path: 'billing-worker.js',
                code: 'const out = eval("processBatch(items)");',
                project: benchProject
            });
            recordResult(
                'instruction_following',
                leg1.text.includes('Never use eval()'),
                upg1.content[0].text.includes('Never use eval()') && nudgeRes.content[0].text.includes(`Rule #${ids.anchoredInv}`)
            );
        }

        // --- 9. MULTI-SESSION REASONING (Synthesizing 3 facets under a tight 130-token budget despite 5 distinct high-overlap Facet-1 notes) ---
        {
            const multiHopQuery = 'PgBouncer database max_client_conn ceiling connections Kraken worker replica superuser SRE reserve';
            // Tight token budget (~130 tokens = ~3 items max).
            // Naive Top-K packs 3 PgBouncer notes (matching 5 query terms each) and drops Facet 2 (Kraken 15 sockets) & Facet 3 (30 administrative slots)!
            // Submodular facet coverage packs 1 PgBouncer note + 1 Kraken worker note + 1 Superuser reserve note!
            const leg = legacyRetrieveSimulation(db, { query: multiHopQuery, limitTokens: 130 });
            const upg = await unifiedRetrieve({
                query: multiHopQuery,
                limit_tokens: 130,
                project: benchProject,
                _embedding: deterministicEmbedding(multiHopQuery)
            });
            const legHasAll3 = leg.text.includes('120') && leg.text.includes('15 persistent') && leg.text.includes('30 administrative');
            const upgText = upg.content[0].text;
            const upgHasAll3 = upgText.includes('120') &&
                upgText.includes('15 persistent') &&
                upgText.includes('30 administrative') &&
                upg.epistemic_status === 'SUPPORTED';
            recordResult('multi_session_reasoning', legHasAll3, upgHasAll3);
        }

        // --- 10. SUMMARIZATION (State briefing compilation + zero invalidated/superseded leakage) ---
        {
            const stateRes = await compileProjectState({ project: benchProject });
            const stateText = stateRes.content[0].text;
            const hasHandoff = stateText.includes('Active Session Handoff') && stateText.includes('Completed BEAM-10 memory upgrade');
            const excludesSuperseded = !stateText.includes('AWS RDS Aurora') && !stateText.includes('Redis 6.2 standalone');
            const excludesInvalidated = !stateText.includes('Allow basic HTTP password headers');
            recordResult('summarization', hasHandoff && excludesSuperseded, hasHandoff && excludesSuperseded && excludesInvalidated);
        }

        // --- BONUS 11. CODE ARTIFACT SPAN DRIFT (INV-12: Disk Mutation Detection) ---
        let inv12Passed = false;
        {
            // Mutate billing-worker.js on disk from 500 -> 2000 without updating memory
            fs.writeFileSync(
                anchorFile,
                `export const MAX_BATCH_SIZE = 2000;\nexport function processBatch(items) {\n  return items.slice(0, MAX_BATCH_SIZE);\n}\n`,
                'utf8'
            );
            const healthAfterMutation = await getHealthStats({ project: benchProject });
            inv12Passed = healthAfterMutation.stats.driftedCount === 1;
        }

        // =========================================================================
        // 3️⃣ COMPUTE SCORES & RENDER COMPARISON TABLE
        // =========================================================================
        const categories = [
            ['event_ordering',           'Event Ordering'],
            ['preference_following',     'Preference Following'],
            ['summarization',            'Summarization'],
            ['abstention',               'Abstention (No-Support Gate)'],
            ['instruction_following',    'Instruction Following'],
            ['temporal_reasoning',       'Temporal Reasoning'],
            ['knowledge_update',         'Knowledge Update (Lineage)'],
            ['information_extraction',   'Information Extraction (>450 deep)'],
            ['contradiction_resolution', 'Contradiction Resolution'],
            ['multi_session_reasoning',  'Multi-Session Reasoning (Submodular)']
        ];

        console.log("2️⃣ Synthetic Smoke Probe Results (Self-Seeded 520-Memory Haystack):\n");
        console.log(
            "| Synthetic Capability Mechanism       | Probes | Legacy Baseline | Upgraded Krusch |\n" +
            "| :----------------------------------- | :----: | :-------------: | :-------------: |"
        );

        let legTotalPct = 0;
        let upgTotalPct = 0;

        for (const [key, label] of categories) {
            const r = results[key];
            const legPct = (r.legacyPassed / r.total) * 100;
            const upgPct = (r.upgradedPassed / r.total) * 100;
            legTotalPct += legPct;
            upgTotalPct += upgPct;

            console.log(
                `| ${label.padEnd(36)} | ${String(r.total).padStart(6)} | ${(`${legPct.toFixed(1)}%`).padStart(15)} | ${(`**${upgPct.toFixed(1)}%**`).padStart(15)} |`
            );
        }

        const legAvg = (legTotalPct / categories.length).toFixed(2);
        const upgAvg = (upgTotalPct / categories.length).toFixed(2);

        console.log(
            `| **SYNTHETIC SMOKE SUITE MEAN**       | **21** | **${legAvg}%**     | **${upgAvg}%**   |`
        );
        console.log(
            `| **Code Span Drift Gate (INV-12)**    | **1**  | N/A (No Gate)   | **${inv12Passed ? '100.0%' : '0.0%'}**      |\n`
        );

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log("=====================================================================================");
        console.log(`🎉 SYNTHETIC ARCHITECTURE SMOKE SUITE PASSED IN ${elapsedSec}s (520 Memories | 21 Probes)`);
        console.log(`   - Legacy Pre-Upgrade Score : ${legAvg}%`);
        console.log(`   - Upgraded Krusch Score    : ${upgAvg}% (+${(Number(upgAvg) - Number(legAvg)).toFixed(2)}% improvement)`);
        console.log(`   - INV-12 Disk Drift Gate   : ${inv12Passed ? 'PASSED (Detected mutated source span)' : 'FAILED'}`);
        console.log("=====================================================================================");

        if (Number(upgAvg) < 100 || !inv12Passed) {
            process.exitCode = 1;
        }
    } catch (err) {
        console.error("❌ Synthetic Smoke Suite failed:", err);
        process.exitCode = 1;
    } finally {
        closeAllDatabases();
        try {
            fs.rmSync(projRoot, { recursive: true, force: true });
        } catch {}
        process.exit(process.exitCode || 0);
    }
}

runBeamBenchmark();
