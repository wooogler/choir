# Service Inventory Report

## Section 1. Quarterly review of runtime components

### 1.1 Table 1

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-001 | ingest-worker | platform | healthy | 40 | nominal |
| SVC-002 | vector-store | search | draining | 90 | flex tier |
| SVC-003 | slack-gateway | integrations | healthy | 140 | cold start 1.2s |
| SVC-004 | github-sync | infra | draining | 190 | pinned to us-east |
| SVC-005 | qmd-index | platform | healthy | 240 | nominal |
| SVC-006 | draft-store | search | draining | 290 | flex tier |
| SVC-007 | mirror-cache | integrations | healthy | 340 | cold start 1.2s |
| SVC-008 | oauth-bridge | infra | draining | 390 | pinned to us-east |
| SVC-009 | reranker | platform | healthy | 440 | nominal |
| SVC-010 | embed-queue | search | draining | 490 | flex tier |

### 1.2 Table 2

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-011 | pdf-gate | integrations | draining | 410 | flex tier |
| SVC-012 | web-fetcher | infra | healthy | 460 | cold start 1.2s |
| SVC-013 | i18n-loader | platform | draining | 510 | pinned to us-east |
| SVC-014 | audit-log | search | healthy | 560 | nominal |
| SVC-015 | metrics-pump | integrations | draining | 610 | flex tier |
| SVC-016 | ingest-worker | platform | degraded | 105 | rate limited 09:00 |
| SVC-017 | vector-store | search | healthy | 155 | n/a |
| SVC-018 | slack-gateway | integrations | degraded | 205 | retry budget 3 |
| SVC-019 | github-sync | infra | healthy | 255 | backfill pending |
| SVC-020 | qmd-index | platform | degraded | 305 | rate limited 09:00 |

## Section 2. Quarterly review of runtime components

### 2.1 Table 3

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-021 | draft-store | integrations | degraded | 225 | pinned to us-east |
| SVC-022 | mirror-cache | infra | healthy | 275 | nominal |
| SVC-023 | oauth-bridge | platform | degraded | 325 | flex tier |
| SVC-024 | reranker | search | healthy | 375 | cold start 1.2s |
| SVC-025 | embed-queue | integrations | degraded | 425 | pinned to us-east |
| SVC-026 | pdf-gate | infra | healthy | 475 | nominal |
| SVC-027 | web-fetcher | platform | degraded | 525 | flex tier |
| SVC-028 | i18n-loader | search | healthy | 575 | cold start 1.2s |
| SVC-029 | audit-log | integrations | degraded | 625 | pinned to us-east |
| SVC-030 | metrics-pump | infra | healthy | 675 | nominal |

### 2.2 Table 4

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-031 | ingest-worker | search | healthy | 40 | retry budget 3 |
| SVC-032 | vector-store | integrations | draining | 90 | backfill pending |
| SVC-033 | slack-gateway | infra | healthy | 140 | rate limited 09:00 |
| SVC-034 | github-sync | platform | draining | 190 | n/a |
| SVC-035 | qmd-index | search | healthy | 240 | retry budget 3 |
| SVC-036 | draft-store | integrations | draining | 290 | backfill pending |
| SVC-037 | mirror-cache | infra | healthy | 340 | rate limited 09:00 |
| SVC-038 | oauth-bridge | platform | draining | 390 | n/a |
| SVC-039 | reranker | search | healthy | 440 | retry budget 3 |
| SVC-040 | embed-queue | integrations | draining | 490 | backfill pending |

## Section 3. Quarterly review of runtime components

### 3.1 Table 5

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-041 | pdf-gate | platform | draining | 410 | cold start 1.2s |
| SVC-042 | web-fetcher | search | healthy | 460 | pinned to us-east |
| SVC-043 | i18n-loader | integrations | draining | 510 | nominal |
| SVC-044 | audit-log | infra | healthy | 560 | flex tier |
| SVC-045 | metrics-pump | platform | draining | 610 | cold start 1.2s |
| SVC-046 | ingest-worker | integrations | degraded | 105 | n/a |
| SVC-047 | vector-store | infra | healthy | 155 | retry budget 3 |
| SVC-048 | slack-gateway | platform | degraded | 205 | backfill pending |
| SVC-049 | github-sync | search | healthy | 255 | rate limited 09:00 |
| SVC-050 | qmd-index | integrations | degraded | 305 | n/a |

### 3.2 Table 6

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-051 | draft-store | infra | degraded | 225 | n/a |
| SVC-052 | mirror-cache | platform | healthy | 275 | retry budget 3 |
| SVC-053 | oauth-bridge | search | degraded | 325 | backfill pending |
| SVC-054 | reranker | integrations | healthy | 375 | rate limited 09:00 |
| SVC-055 | embed-queue | infra | degraded | 425 | n/a |
| SVC-056 | pdf-gate | platform | healthy | 475 | retry budget 3 |
| SVC-057 | web-fetcher | search | degraded | 525 | backfill pending |
| SVC-058 | i18n-loader | integrations | healthy | 575 | rate limited 09:00 |
| SVC-059 | audit-log | infra | degraded | 625 | n/a |
| SVC-060 | metrics-pump | platform | healthy | 675 | retry budget 3 |

## Section 4. Quarterly review of runtime components

### 4.1 Table 7

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-061 | ingest-worker | infra | healthy | 40 | backfill pending |
| SVC-062 | vector-store | platform | draining | 90 | rate limited 09:00 |
| SVC-063 | slack-gateway | search | healthy | 140 | n/a |
| SVC-064 | github-sync | integrations | draining | 190 | retry budget 3 |
| SVC-065 | qmd-index | infra | healthy | 240 | backfill pending |
| SVC-066 | draft-store | platform | draining | 290 | rate limited 09:00 |
| SVC-067 | mirror-cache | search | healthy | 340 | n/a |
| SVC-068 | oauth-bridge | integrations | draining | 390 | retry budget 3 |
| SVC-069 | reranker | infra | healthy | 440 | backfill pending |
| SVC-070 | embed-queue | platform | draining | 490 | rate limited 09:00 |

### 4.2 Table 8

| ID | Component | Owner | Status | Latency (ms) | Notes |
|---|---|---|---|---|---|
| SVC-071 | pdf-gate | search | draining | 410 | rate limited 09:00 |
| SVC-072 | web-fetcher | integrations | healthy | 460 | n/a |
| SVC-073 | i18n-loader | infra | draining | 510 | retry budget 3 |
| SVC-074 | audit-log | platform | healthy | 560 | backfill pending |
| SVC-075 | metrics-pump | search | draining | 610 | rate limited 09:00 |
| SVC-076 | ingest-worker | infra | degraded | 105 | nominal |
| SVC-077 | vector-store | platform | healthy | 155 | flex tier |
| SVC-078 | slack-gateway | search | degraded | 205 | cold start 1.2s |
| SVC-079 | github-sync | integrations | healthy | 255 | pinned to us-east |
| SVC-080 | qmd-index | infra | degraded | 305 | nominal |