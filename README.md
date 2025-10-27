Documentation de l’API (Brokex API+)

Base URL de prod (après config) : **`https://api.brokex.trade`**
Toutes les réponses sont en JSON.
Codes d’erreur usuels : `400` (bad_request), `404` (not_found …), `500` (internal_error).

## Health

### `GET /health`

Ping minimal (PostgREST).

* **200** `{ "ok": true }`
* **500** `{ "ok": false, "error": "postgrest_unreachable" }`

**Exemple**

```bash
curl -s https://api.brokex.trade/health
```

---

## Assets

### `GET /assets`

Liste des actifs.

* **200** `[{ asset_id, symbol, tick_size_usd6, lot_num, lot_den }, ...]`

### `GET /assets/:assetId`

Détail d’un actif.

* **200** `{ asset_id, symbol, tick_size_usd6, lot_num, lot_den }`
* **400** `{ "error": "asset_id_invalid" }`
* **404** `{ "error": "asset_not_found" }`

**Exemples**

```bash
curl -s https://api.brokex.trade/assets
curl -s https://api.brokex.trade/assets/0
```

---

## Positions

### `GET /position/:id`

Détail d’une position (champ `*` depuis `positions`).

* **200** `{ ...tous les champs de la position... }`
* **404** `{ "error": "position_not_found" }`

**Exemple**

```bash
curl -s https://api.brokex.trade/position/3798
```

---

## Trader — regroupement d’IDs

### `GET /trader/:addr`

Adresse EVM (0x… 40 hex).

* **200**

```json
{
  "trader": "0xabc...def",
  "orders":  [1,2,3],   // state=0
  "open":    [4,5,6],   // state=1
  "cancelled": [7,8],   // state=2 & close_reason=0
  "closed":    [9,10]   // state=2 & close_reason != 0
}
```

* **400** `{ "error": "invalid_address" }`

**Exemple**

```bash
curl -s https://api.brokex.trade/trader/0x0000000000000000000000000000000000000000
```

---

## Buckets (orders & stops)

Deux endpoints symétriques :

* `GET /bucket/orders` (table `order_buckets`)
* `GET /bucket/stops`  (table `stop_buckets`)

Paramètres communs (query) :

* `asset` **(number, requis)** : `asset_id`
* *Au choix* **`bucket`** *(string)* ou **`price`** *(string décimale)*

  * Si `price` est fourni, le serveur calcule `bucket_id = floor(price_x6 / tick_size_usd6)` de l’asset.
* `side` *(optional)* : `long` | `short` | `all` (def. `all`)
* `sort` *(optional)* : `lots` | `id` (def. `lots`)
* `order` *(optional)* : `desc` | `asc` (def. `desc`)

### A) Orders

#### `GET /bucket/orders?asset=…&price=…` *ou* `&bucket=…`

**200**

```json
{
  "asset": 0,
  "bucket_id": "10917030",
  "count": 2,
  "items": [
    { "id": 1234, "lots": 10, "side": "LONG" },
    { "id": 5678, "lots":  4, "side": "SHORT" }
  ]
}
```

**Erreurs possibles**

* `400 { "error": "asset_required" }`
* `400 { "error": "price_or_bucket_required" }`
* `404 { "error": "asset_not_found" }` (si asset inconnu)
* `400 { "error": "bad_tick" }` (tick_size_usd6 <= 0)
* `500 { "error": "internal_error" }`

**Exemples**

```bash
# via prix
curl -s "https://api.brokex.trade/bucket/orders?asset=0&price=108910.01&side=long&sort=lots&order=desc"

# via bucket_id direct
curl -s "https://api.brokex.trade/bucket/orders?asset=0&bucket=10917030"
```

### B) Stops (SL / TP / LIQ)

#### `GET /bucket/stops?asset=…&price=…` *ou* `&bucket=…`

**200**

```json
{
  "asset": 0,
  "bucket_id": "10917030",
  "count": 3,
  "items": [
    { "id": 2001, "type": "SL",  "lots": 2, "side": "LONG" },
    { "id": 2002, "type": "TP",  "lots": 1, "side": "SHORT" },
    { "id": 2003, "type": "LIQ", "lots": 3, "side": "LONG" }
  ]
}
```

> `type` est mappé depuis `stop_type` : `1=SL`, `2=TP`, `3=LIQ`, sinon `UNK`.

**Exemples**

```bash
curl -s "https://api.brokex.trade/bucket/stops?asset=0&bucket=10917030&sort=id&order=asc"
```

---

## Exposure (agrégats)

### `GET /exposure`

Retourne des métriques agrégées **par asset et par side** (vue `exposure_metrics`).

* **200** `[{ asset_id, side_label, sum_lots, avg_entry_x6, avg_leverage_x, avg_liq_x6, positions_count }, ...]`

### `GET /exposure/:assetId`

**200**

```json
{
  "asset_id": 0,
  "long": {
    "sum_lots": 123,
    "avg_entry_x6": 108910010000,
    "avg_leverage_x": 43,
    "avg_liq_x6":  987650000,
    "positions_count": 14
  },
  "short": {
    "sum_lots": 45,
    "avg_entry_x6": 108700000000,
    "avg_leverage_x": 51,
    "avg_liq_x6":  800000000,
    "positions_count": 9
  }
}
```

* **400** `{ "error": "asset_id_invalid" }`

**Exemples**

```bash
curl -s https://api.brokex.trade/exposure
curl -s https://api.brokex.trade/exposure/0
```

---

## Formats d’erreur

* `400` : `{ "error": "bad_request" | "asset_required" | "price_or_bucket_required" | "asset_id_invalid" | "invalid_address" | "bad_tick" }`
* `404` : `{ "error": "not_found" | "asset_not_found" | "position_not_found" }`
* `500` : `{ "error": "internal_error" | "postgrest_unreachable" }`

---

## Notes d’implémentation utiles

* **CORS** : activé côté app (`app.use(cors())`).
* **Port** : `API_PORT` ou `PORT` (fallback `7392`).
* **Bucket via price** :

  * `priceStrToX6("108910.01")` → BigInt x6 (108910010000).
  * `bucket_id = floor(price_x6 / tick_size_usd6)` depuis `assets.tick_size_usd6`.
* **Sides** : `true` → `LONG`, `false` → `SHORT`, `null` = *all* (pas de filtre).
* **Tri** : `sort=lots|id`, `order=desc|asc` (défauts `lots/desc`).

