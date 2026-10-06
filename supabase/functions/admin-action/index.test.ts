import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escolherVencimentoReal, calcAtrasoInfo, GRACE_DIAS_ATRASO, calcTrialInfo, JANELA_AVISO_TRIAL } from "./vencimento.ts";

// ── Caso real: Vinícius Serpa da Costa (sub_mglli2olknadvknb) ──────
// Pago até 17/08 (RECEIVED), mas existe fatura de R$70 vencendo 17/09
// ainda PENDING — o bug antigo mostrava 17/10 (nextDueDate da Asaas,
// que já tinha avançado um ciclo à frente da fatura em aberto).
Deno.test("escolherVencimentoReal - usa a fatura pendente mais próxima, não o nextDueDate adiantado", () => {
  const pagamentos = [
    { status: "RECEIVED", dueDate: "2026-08-17" },
    { status: "PENDING", dueDate: "2026-09-17" },
  ];
  const resultado = escolherVencimentoReal(pagamentos, "2026-10-17");
  assertEquals(resultado, "2026-09-17");
});

// ── Caso real: Carlos Henrique (atrasado) ──────────────────────────
Deno.test("escolherVencimentoReal - fatura OVERDUE conta como em aberto (mostra atraso real)", () => {
  const pagamentos = [
    { status: "RECEIVED", dueDate: "2026-07-17" },
    { status: "OVERDUE", dueDate: "2026-08-17" },
  ];
  const resultado = escolherVencimentoReal(pagamentos, "2026-09-17");
  assertEquals(resultado, "2026-08-17");
});

Deno.test("escolherVencimentoReal - sem nenhuma fatura em aberto, cai pro nextDueDate da assinatura", () => {
  const pagamentos = [
    { status: "RECEIVED", dueDate: "2026-07-17" },
    { status: "CONFIRMED", dueDate: "2026-08-17" },
  ];
  const resultado = escolherVencimentoReal(pagamentos, "2026-09-17");
  assertEquals(resultado, "2026-09-17");
});

Deno.test("escolherVencimentoReal - lista de pagamentos vazia cai pro nextDueDate", () => {
  const resultado = escolherVencimentoReal([], "2026-09-17");
  assertEquals(resultado, "2026-09-17");
});

Deno.test("escolherVencimentoReal - sem faturas em aberto e sem nextDueDate retorna null", () => {
  const resultado = escolherVencimentoReal([{ status: "RECEIVED", dueDate: "2026-07-17" }], null);
  assertEquals(resultado, null);
});

Deno.test("escolherVencimentoReal - múltiplas faturas em aberto: pega a de vencimento mais próximo (não a mais recente na lista)", () => {
  const pagamentos = [
    { status: "PENDING", dueDate: "2026-11-17" },
    { status: "OVERDUE", dueDate: "2026-08-17" },
    { status: "PENDING", dueDate: "2026-09-17" },
  ];
  const resultado = escolherVencimentoReal(pagamentos, "2026-12-17");
  assertEquals(resultado, "2026-08-17");
});

// ── Tolerância de 3 dias após o vencimento (regra pedida pelo Well) ────────
Deno.test("calcAtrasoInfo - grace period é 3 dias", () => {
  assertEquals(GRACE_DIAS_ATRASO, 3);
});

Deno.test("calcAtrasoInfo - dia do vencimento (0 dias de atraso): acesso liberado, sem urgência", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-17");
  assertEquals(r, { diasAtraso: 0, diasRestantes: 3, ultimoDia: false, bloqueado: false });
});

Deno.test("calcAtrasoInfo - 1 dia de atraso: faltam 2 dias, ainda usa", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-18");
  assertEquals(r, { diasAtraso: 1, diasRestantes: 2, ultimoDia: false, bloqueado: false });
});

Deno.test("calcAtrasoInfo - 2 dias de atraso: falta 1 dia, ainda usa", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-19");
  assertEquals(r, { diasAtraso: 2, diasRestantes: 1, ultimoDia: false, bloqueado: false });
});

Deno.test("calcAtrasoInfo - 3 dias de atraso: último dia, ainda usa, dispara aviso final", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-20");
  assertEquals(r, { diasAtraso: 3, diasRestantes: 0, ultimoDia: true, bloqueado: false });
});

Deno.test("calcAtrasoInfo - 4 dias de atraso: passou da tolerância, bloqueado", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-21");
  assertEquals(r, { diasAtraso: 4, diasRestantes: 0, ultimoDia: false, bloqueado: true });
});

Deno.test("calcAtrasoInfo - 10 dias de atraso: continua bloqueado (não desbloqueia sozinho)", () => {
  const r = calcAtrasoInfo("2026-08-17", "2026-08-27");
  assertEquals(r, { diasAtraso: 10, diasRestantes: 0, ultimoDia: false, bloqueado: true });
});

Deno.test("calcAtrasoInfo - sem vencimento cadastrado: não bloqueia (não penaliza dado ausente)", () => {
  const r = calcAtrasoInfo(null, "2026-08-20");
  assertEquals(r, { diasAtraso: 0, diasRestantes: 3, ultimoDia: false, bloqueado: false });
});

// ── Acesso de teste: vale só os dias exatos dados pelo admin, sem tolerância extra ──
Deno.test("calcTrialInfo - janela de aviso é 3 dias", () => {
  assertEquals(JANELA_AVISO_TRIAL, 3);
});

Deno.test("calcTrialInfo - sem validade cadastrada: null (não é trial, ou nunca foi configurado)", () => {
  assertEquals(calcTrialInfo(null, "2026-08-19"), null);
});

Deno.test("calcTrialInfo - 5 dias antes de vencer: ainda fora da janela de aviso", () => {
  const r = calcTrialInfo("2026-08-24", "2026-08-19");
  assertEquals(r, { diasRestantes: 5, avisar: false, ultimoDia: false, vencido: false });
});

Deno.test("calcTrialInfo - 3 dias antes de vencer: começa o aviso", () => {
  const r = calcTrialInfo("2026-08-22", "2026-08-19");
  assertEquals(r, { diasRestantes: 3, avisar: true, ultimoDia: false, vencido: false });
});

Deno.test("calcTrialInfo - 1 dia antes de vencer: aviso ativo", () => {
  const r = calcTrialInfo("2026-08-20", "2026-08-19");
  assertEquals(r, { diasRestantes: 1, avisar: true, ultimoDia: false, vencido: false });
});

Deno.test("calcTrialInfo - dia exato do vencimento: último dia, ainda usa, dispara e-mail", () => {
  const r = calcTrialInfo("2026-08-19", "2026-08-19");
  assertEquals(r, { diasRestantes: 0, avisar: true, ultimoDia: true, vencido: false });
});

Deno.test("calcTrialInfo - 1 dia depois do vencimento: vencido, sem tolerância extra (diferente do atraso pago)", () => {
  const r = calcTrialInfo("2026-08-18", "2026-08-19");
  assertEquals(r, { diasRestantes: -1, avisar: false, ultimoDia: false, vencido: true });
});

Deno.test("calcTrialInfo - vencido há muito tempo: continua vencido", () => {
  const r = calcTrialInfo("2026-06-01", "2026-08-19");
  assertEquals(r?.vencido, true);
  assertEquals(r?.avisar, false);
});

// ── Desconto temporário por assinatura (SERPA30: R$30 até dez/2026) ──
import { faturasParaDesconto } from "./vencimento.ts";

Deno.test("faturasParaDesconto - ajusta só faturas em aberto com competência até a data limite", () => {
  const pagamentos = [
    { id: 'ago', status: 'RECEIVED', dueDate: '2026-08-17', value: 70 },  // já paga: nunca mexe
    { id: 'set', status: 'OVERDUE',  dueDate: '2026-09-17', value: 70 },  // atrasada: entra
    { id: 'out', status: 'PENDING',  dueDate: '2026-10-17', value: 70 },  // entra
    { id: 'dez', status: 'PENDING',  dueDate: '2026-12-17', value: 70 },  // último mês: entra
    { id: 'jan', status: 'PENDING',  dueDate: '2027-01-17', value: 70 },  // depois do limite: cheia
  ];
  assertEquals(faturasParaDesconto(pagamentos, 30, '2026-12-31').map(p => p.id), ['set', 'out', 'dez']);
});

Deno.test("faturasParaDesconto - idempotente: fatura já no valor do desconto não é reajustada", () => {
  const pagamentos = [{ status: 'PENDING', dueDate: '2026-10-17', value: 30 }];
  assertEquals(faturasParaDesconto(pagamentos, 30, '2026-12-31').length, 0);
});

Deno.test("faturasParaDesconto - vale a competência original, mesmo se o vencimento foi prorrogado", () => {
  const dezProrrogada = { status: 'PENDING', dueDate: '2027-01-05', originalDueDate: '2026-12-17', value: 70 };
  const janAntecipada = { status: 'PENDING', dueDate: '2026-12-30', originalDueDate: '2027-01-17', value: 70 };
  assertEquals(faturasParaDesconto([dezProrrogada, janAntecipada], 30, '2026-12-31'), [dezProrrogada]);
});
