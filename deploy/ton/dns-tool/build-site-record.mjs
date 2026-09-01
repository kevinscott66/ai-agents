#!/usr/bin/env node
// Строит payload транзакции change_dns_record (op 0x4eb1f0f9) для привязки
// TON Site к .ton-домену: категория sha256("site"), запись dns_adnl_address#ad01.
// Формат сверен с tonutils-go ton/dns/resolve.go (BuildSetSiteRecordPayload) и
// TEP-81. Транзакцию шлёт кошелёк-владелец NFT домена на адрес контракта NFT
// с ~0.02 TON.
//
// Использование:
//   node build-site-record.mjs --adnl <hex 64 символа> [--nft <адрес NFT EQ...>]
//   node build-site-record.mjs --self-test
//
// hex ADNL-адреса печатает tonutils-reverse-proxy при старте (поле hex_address).
// Вывод: base64 BOC (для кошелёк-тулов с payload.type=base64, напр. My Wallet
// MCP mywallet_submit_transfer) и ton://-ссылка (если задан --nft).

import { beginCell, Cell, Address } from "@ton/core";
import { createHash, randomBytes } from "node:crypto";

const OP_CHANGE_DNS_RECORD = 0x4eb1f0f9;
const CATEGORY_ADNL_SITE = 0xad01;
const AMOUNT_NANO = 20_000_000n; // 0.02 TON, как в tonutils-reverse-proxy

function buildSiteRecordBody(adnlHex, queryId) {
  // Строгая проверка ДО декодирования: Buffer.from(..., "hex") молча
  // обрезает мусорный хвост/нечётную длину — сдвиг на символ дал бы
  // другой 32-байтовый адрес и транзакцию с неверной записью.
  if (!/^[0-9a-f]{64}$/.test(adnlHex)) {
    throw new Error(
      "ADNL-адрес должен быть ровно 64 hex-символа (32 байта), без пробелов и лишних символов",
    );
  }
  const adnl = Buffer.from(adnlHex, "hex");
  const categoryKey = createHash("sha256").update("site").digest();
  const record = beginCell()
    .storeUint(CATEGORY_ADNL_SITE, 16)
    .storeBuffer(adnl, 32)
    .storeUint(0, 8) // flags = 0, без proto_list
    .endCell();
  return beginCell()
    .storeUint(OP_CHANGE_DNS_RECORD, 32)
    .storeUint(queryId, 64)
    .storeBuffer(categoryKey, 32)
    .storeRef(record)
    .endCell();
}

function selfTest() {
  const adnlHex = "aa".repeat(32);
  const body = buildSiteRecordBody(adnlHex, 777n);
  // Разбираем обратно и сверяем каждое поле.
  const s = body.beginParse();
  const op = s.loadUint(32);
  const qid = s.loadUintBig(64);
  const key = s.loadBuffer(32);
  const ref = s.loadRef().beginParse();
  const cat = ref.loadUint(16);
  const addr = ref.loadBuffer(32);
  const flags = ref.loadUint(8);
  const expectKey = createHash("sha256").update("site").digest();
  const checks = [
    [op === OP_CHANGE_DNS_RECORD, "op"],
    [qid === 777n, "query_id"],
    [key.equals(expectKey), "category sha256(site)"],
    [cat === CATEGORY_ADNL_SITE, "record prefix 0xad01"],
    [addr.equals(Buffer.from(adnlHex, "hex")), "adnl addr"],
    [flags === 0, "flags"],
    [s.remainingBits === 0 && ref.remainingBits === 0, "no trailing bits"],
    // BOC должен парситься обратно в ту же ячейку
    [Cell.fromBoc(body.toBoc())[0].hash().equals(body.hash()), "boc roundtrip"],
  ];
  const failed = checks.filter(([ok]) => !ok);
  if (failed.length) {
    console.error("SELF-TEST FAILED:", failed.map(([, n]) => n).join(", "));
    process.exit(1);
  }
  console.log("self-test ok");
}

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const adnlHex = argVal("--adnl");
if (!adnlHex) {
  console.error("Нужен --adnl <hex 64 символа> (hex_address из лога tonutils-reverse-proxy). Или --self-test.");
  process.exit(1);
}

try {
  // Валидируем ОБА аргумента до какого-либо вывода: частично напечатанный
  // payload перед ошибкой легко скопировать не глядя.
  const nft = argVal("--nft");
  let nftAddr = null;
  if (nft !== undefined) {
    try {
      nftAddr = Address.parse(nft);
    } catch {
      throw new Error(`--nft: не похоже на TON-адрес: ${nft}`);
    }
  }

  const queryId = BigInt("0x" + randomBytes(8).toString("hex"));
  const body = buildSiteRecordBody(
    adnlHex.toLowerCase().replace(/^0x/, ""),
    queryId,
  );
  const boc = body.toBoc();

  console.log("payload base64 (для кошелька, payload.type=base64):");
  console.log(boc.toString("base64"));
  console.log();
  console.log("amount (nanoTON):", AMOUNT_NANO.toString(), "(= 0.02 TON)");
  console.log();
  if (nftAddr) {
    console.log("ton://-ссылка (открыть кошельком-владельцем NFT):");
    console.log(
      `ton://transfer/${nftAddr.toString({ urlSafe: true, bounceable: true })}?bin=${boc.toString("base64url")}&amount=${AMOUNT_NANO}`,
    );
  } else {
    console.log("Адрес назначения: контракт NFT домена (добавь --nft <EQ...> для готовой ton://-ссылки).");
  }
} catch (e) {
  console.error("Ошибка:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
