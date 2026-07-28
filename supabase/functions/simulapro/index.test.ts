// Golden tests do motor de cálculo (SAC/PRICE/FGTS/seguro/SIRC).
// Protege contra regressão silenciosa em fórmulas que viram compromisso
// de compra de imóvel — rode com `deno test` antes de qualquer deploy
// que toque em index.ts.
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import {
  FAIXAS,
  getFaixa,
  getFaixasComTeto,
  calcFGTSMax,
  calcP100kDinamico,
  pctSeguroObra,
  calcularSeguroTotal,
  executarSimulacao,
} from "./index.ts";

// ── getFaixasComTeto: teto MCMV de Faixa 1/2 varia por município ─
Deno.test("getFaixasComTeto - ajusta só Faixa 1 e 2, mantém Faixa 3/4/SBPE intactas", () => {
  const ajustadas = getFaixasComTeto(210000); // cidade pequena, grupo 4
  assertEquals(ajustadas.find(f => f.tag === 'f1')?.iMax, 210000);
  assertEquals(ajustadas.find(f => f.tag === 'f2')?.iMax, 210000);
  assertEquals(ajustadas.find(f => f.tag === 'f3')?.iMax, 400000); // não muda
  assertEquals(ajustadas.find(f => f.tag === 'f4')?.iMax, 600000); // não muda
  assertEquals(ajustadas.find(f => f.tag === 'fsbpe')?.iMax, null); // não muda
});

Deno.test("getFaixasComTeto - não modifica o array FAIXAS original (imutabilidade)", () => {
  getFaixasComTeto(210000);
  assertEquals(FAIXAS.find(f => f.tag === 'f1')?.iMax, 275000);
});

// ── getFaixa: enquadramento por renda e regra de região ──────────
Deno.test("getFaixa - limites exatos de cada faixa MCMV", () => {
  assertEquals(getFaixa(2000).tag, "f1");
  assertEquals(getFaixa(2850).tag, "f1"); // limite exato ainda entra na Faixa 1
  assertEquals(getFaixa(2851).tag, "f2"); // passou do limite, cai pra Faixa 2
  assertEquals(getFaixa(5000).tag, "f2");
  assertEquals(getFaixa(5001).tag, "f3");
  assertEquals(getFaixa(9600).tag, "f3");
  assertEquals(getFaixa(9601).tag, "f4");
  assertEquals(getFaixa(13000).tag, "f4");
  assertEquals(getFaixa(13001).tag, "fsbpe");
});

Deno.test("getFaixa - fora da região do imóvel força SBPE independente da renda", () => {
  const fx = getFaixa(2000, false); // renda baixíssima, mas não reside na região
  assertEquals(fx.tag, "fsbpe");
  assertEquals(fx.sbpe, true);
});

// ── calcFGTSMax: teto de FGTS por linha de crédito ────────────────
Deno.test("calcFGTSMax - MCMV exige financiamento mínimo de R$50k", () => {
  // vi=300000, va=330000, ato=20000 → limite = 300000-50000-20000 = 230000
  const max = calcFGTSMax(300000, 330000, 20000, FAIXAS[2]); // Faixa 3, sbpe:false
  assertEquals(max, 230000);
});

Deno.test("calcFGTSMax - SBPE exige financiamento mínimo de R$100k", () => {
  // mesmos valores, mas SBPE: limite = 300000-100000-20000 = 180000
  const max = calcFGTSMax(300000, 330000, 20000, FAIXAS[4]); // SBPE
  assertEquals(max, 180000);
});

Deno.test("calcFGTSMax - nunca retorna negativo (imóvel barato + ato alto)", () => {
  const max = calcFGTSMax(60000, 66000, 20000, FAIXAS[2]);
  assertEquals(max, 0);
});

// ── calcP100kDinamico: fórmulas SAC/PRICE de juros compostos ─────
Deno.test("calcP100kDinamico - PRICE bate com fórmula financeira padrão (360 meses, 8.16% a.a.)", () => {
  // i = 8.16/100/12; p100k = i*(1+i)^360 / ((1+i)^360 - 1) * 100000
  const p100k = calcP100kDinamico(8.16, 360, false);
  assertAlmostEquals(p100k, 744.95, 0.1);
});

Deno.test("calcP100kDinamico - SAC usa a 1ª parcela (maior) como referência", () => {
  // SAC: (1/n + i) * 100000
  const p100k = calcP100kDinamico(8.16, 360, true);
  assertAlmostEquals(p100k, 957.78, 0.1);
});

Deno.test("calcP100kDinamico - fallback quando taxa ou prazo vêm zerados", () => {
  assertEquals(calcP100kDinamico(0, 0, false), 976);
  assertEquals(calcP100kDinamico(0, 0, true), 1172);
});

// ── pctSeguroObra: curva progressiva do seguro de obra ────────────
Deno.test("pctSeguroObra - começa no piso de 15% no primeiro mês", () => {
  assertEquals(pctSeguroObra(1, 36), 0.15);
});

Deno.test("pctSeguroObra - cruza ~33% no fim do primeiro terço", () => {
  assertAlmostEquals(pctSeguroObra(12, 36), 0.33, 0.01);
});

Deno.test("pctSeguroObra - chega a 95% no último mês", () => {
  assertEquals(pctSeguroObra(36, 36), 0.95);
});

// ── calcularSeguroTotal: teto acumulado por sistema ───────────────
Deno.test("calcularSeguroTotal - nunca ultrapassa o teto (10% PRICE / 12% SAC) do financiado", () => {
  const financiado = 300000;
  const segPrice = calcularSeguroTotal(financiado, 24, 30, 0.0068, false, "", "");
  const segSac    = calcularSeguroTotal(financiado, 24, 30, 0.0068, true, "", "");
  if (segPrice.total > financiado * 0.10 + 1) throw new Error(`seguro PRICE (${segPrice.total}) estourou o teto de 10%`);
  if (segSac.total   > financiado * 0.12 + 1) throw new Error(`seguro SAC (${segSac.total}) estourou o teto de 12%`);
});

Deno.test("calcularSeguroTotal - sem financiamento ou sem meses de obra retorna zero", () => {
  const seg = calcularSeguroTotal(0, 0, 30, 0.0068, false, "", "");
  assertEquals(seg.total, 0);
});

// ── executarSimulacao: cenário completo end-to-end ────────────────
Deno.test("executarSimulacao - Faixa 3 (MCMV): financia no máximo 80% da avaliação em ambos os sistemas", () => {
  const sim = executarSimulacao({
    renda: 9000, vImovel: 350000, vAval: 385000, ato: 30000,
    fgtsPode: true, fgtsDisp: 20000, prazoAnos: 30, mesesObra: 24,
    tipoTaxa: "n", dtEntrega: "", dtLancamento: "", sistemaAtivo: "sac",
    dataNasc: "1990-01-01",
  });
  assertEquals(sim.faixa.tag, "f3");
  assertEquals(sim.calcSAC.pct, 0.80);
  assertEquals(sim.calcPRICE.pct, 0.80);
  // financiado nunca pode exceder 80% da avaliação (regra de ouro do banco)
  if (sim.finSAC   > 385000 * 0.80 + 1) throw new Error("SAC financiou acima do limite de 80%");
  if (sim.finPRICE > 385000 * 0.80 + 1) throw new Error("PRICE financiou acima do limite de 80%");
});

Deno.test("executarSimulacao - SBPE: SAC financia até 90%, PRICE até 80% da avaliação", () => {
  const sim = executarSimulacao({
    renda: 20000, vImovel: 800000, vAval: 880000, ato: 100000,
    fgtsPode: false, fgtsDisp: 0, prazoAnos: 30, mesesObra: 0,
    tipoTaxa: "n", dtEntrega: "", dtLancamento: "", sistemaAtivo: "price",
  });
  assertEquals(sim.faixa.tag, "fsbpe");
  assertEquals(sim.calcSAC.pct, 0.90);
  assertEquals(sim.calcPRICE.pct, 0.80);
});

Deno.test("executarSimulacao - prazo máximo é sempre travado em 35 anos mesmo se pedirem mais", () => {
  const sim = executarSimulacao({
    renda: 9000, vImovel: 350000, vAval: 385000, ato: 30000,
    fgtsPode: false, fgtsDisp: 0, prazoAnos: 50, mesesObra: 0,
    tipoTaxa: "n", dtEntrega: "", dtLancamento: "", sistemaAtivo: "sac",
  });
  assertEquals(sim.prazoA, 35);
});

// ── Personalização do valor financiado (teto de +R$12.000) ───────
const BASE_PARAMS = {
  renda: 9000, vImovel: 350000, vAval: 385000, ato: 30000,
  fgtsPode: false, fgtsDisp: 0, prazoAnos: 30, mesesObra: 24,
  tipoTaxa: "n", dtEntrega: "", dtLancamento: "", sistemaAtivo: "sac",
} as const;

Deno.test("executarSimulacao - sem finManualOverride, finSAC é 100% automático", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS });
  assertEquals(auto.finManualAplicado, null);
  assertEquals(auto.finManualClampado, false);
  assertEquals(auto.finSAC, auto.calcSAC.fin);
});

Deno.test("executarSimulacao - personalizado dentro do teto (+R$12k) é aplicado exatamente", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS });
  const desejado = auto.finSAC + 5000;
  const custom = executarSimulacao({ ...BASE_PARAMS, finManualOverride: desejado });
  assertEquals(custom.finManualAplicado, desejado);
  assertEquals(custom.finManualClampado, false);
  assertEquals(custom.finSAC, desejado);
  // seguro de obra deve ser recalculado sobre o valor personalizado, não o automático
  if (custom.seguroTotal <= auto.seguroTotal) throw new Error("seguro não recalculou sobre o valor personalizado");
});

Deno.test("executarSimulacao - personalizado acima do teto trava em automático + R$12.000", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS });
  const teto = auto.finSAC + 12000;
  const custom = executarSimulacao({ ...BASE_PARAMS, finManualOverride: auto.finSAC + 999999 });
  assertEquals(custom.finManualAplicado, teto);
  assertEquals(custom.finManualClampado, true);
  assertEquals(custom.finSAC, teto);
});

Deno.test("executarSimulacao - personalizado abaixo do automático trava no próprio automático (só permite aumentar)", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS });
  const custom = executarSimulacao({ ...BASE_PARAMS, finManualOverride: auto.finSAC - 5000 });
  assertEquals(custom.finManualAplicado, auto.finSAC);
  assertEquals(custom.finManualClampado, true);
  assertEquals(custom.finSAC, auto.finSAC);
});

Deno.test("executarSimulacao - personalização não altera calcSAC.fin (diagnóstico automático de FGTS/entrada continua intacto)", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS });
  const custom = executarSimulacao({ ...BASE_PARAMS, finManualOverride: auto.finSAC + 8000 });
  assertEquals(custom.calcSAC.fin, auto.calcSAC.fin);
});

Deno.test("executarSimulacao - teto de personalização é relativo ao sistema ativo (SAC e PRICE têm bases diferentes)", () => {
  const auto = executarSimulacao({ ...BASE_PARAMS, sistemaAtivo: "price" });
  assertEquals(auto.finManualBase, auto.calcPRICE.fin);
  assertEquals(auto.finManualTeto, auto.calcPRICE.fin + 12000);
});
