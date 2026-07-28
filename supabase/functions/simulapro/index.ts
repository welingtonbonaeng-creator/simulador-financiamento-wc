import { createClient } from 'npm:@supabase/supabase-js@2';

/* ── DADOS PROTEGIDOS (nunca expostos ao frontend) ── */
export const FAIXAS = [
  { nome:'Faixa 1', tag:'f1', rMax:2850,  iMax:275000, maxPct:0.80, sbpe:false,
    subs:[{a:2160,n:4.25,e:4.75,p100k:525},{a:2850,n:4.50,e:5.00,p100k:542}] },
  { nome:'Faixa 2', tag:'f2', rMax:5000,  iMax:275000, maxPct:0.80, sbpe:false,
    subs:[{a:3200,n:4.75,e:5.25,p100k:560},{a:3500,n:5.00,e:5.50,p100k:575},{a:4000,n:5.50,e:6.00,p100k:620},{a:5000,n:6.50,e:7.00,p100k:690}] },
  { nome:'Faixa 3', tag:'f3', rMax:9600,  iMax:400000, maxPct:0.80, sbpe:false,
    subs:[{a:9600,n:7.66,e:8.16,p100k:776}] },
  { nome:'Faixa 4', tag:'f4', rMax:13000, iMax:600000, maxPct:0.80, sbpe:false,
    subs:[{a:13000,n:10.00,e:10.00,p100k:930}] },
  { nome:'SBPE', tag:'fsbpe', rMax:null, iMax:null, maxPct:0.80, maxPctSAC:0.90, sbpe:true,
    subs:[{a:null,n:11.49,e:11.49,p100k:976,p100k_sac:1172}] },
];

/* Teto padrão (Faixa 1/2) quando o corretor não informa o município — mantém
   o comportamento histórico (região metropolitana do Rio, R$275.000). */
const TETO_PADRAO_F1_F2 = 275000;

/* Retorna uma cópia de FAIXAS com o teto (iMax) de Faixa 1 e Faixa 2 ajustado
   pelo grupo MCMV do município informado (busca sempre no backend). */
export function getFaixasComTeto(tetoF1F2: number) {
  return FAIXAS.map(f => (f.tag === 'f1' || f.tag === 'f2') ? { ...f, iMax: tetoF1F2 } : f);
}

const SEGURO_FAIXAS = [
  { fase:'início da obra',    mInicio:1,  mFim:12, minR:500,  maxR:1000, pctObra:'0% – 30%',  pctProg:30 },
  { fase:'obra em andamento', mInicio:13, mFim:24, minR:1100, maxR:1500, pctObra:'30% – 60%', pctProg:60 },
  { fase:'obra final',        mInicio:25, mFim:30, minR:1600, maxR:3000, pctObra:'60% – 80%', pctProg:80 },
  { fase:'conclusão',         mInicio:31, mFim:36, minR:2200, maxR:3000, pctObra:'80% – 100%', pctProg:100 },
];

/* ── FUNÇÕES PURAS DE CÁLCULO ── */
export function getFaixa(renda: number, residenteRegiao = true) {
  // Regra MCMV: só se enquadra quem reside ou trabalha na região do imóvel.
  // Fora da região → SBPE direto, renda não importa para o enquadramento.
  if (!residenteRegiao) return FAIXAS[FAIXAS.length - 1];
  return FAIXAS.find(f => f.rMax === null || renda <= f.rMax) || FAIXAS[4];
}

function getSub(fx: typeof FAIXAS[0], renda: number) {
  return fx.subs.find((s: any) => s.a === null || renda <= s.a) || fx.subs[fx.subs.length - 1];
}

function getPct(fx: typeof FAIXAS[0], isSAC: boolean): number {
  if (fx.sbpe) return isSAC ? ((fx as any).maxPctSAC || 0.90) : fx.maxPct;
  return fx.maxPct;
}

function getPctRenda(fx: typeof FAIXAS[0], isSAC: boolean): number {
  if (fx.sbpe) return isSAC ? 0.30 : 0.25;
  return 0.30;
}

function getP100k(fx: typeof FAIXAS[0], sub: any, isSAC: boolean): number {
  if (!sub) return 776;
  if (fx.sbpe && sub.p100k_sac) return isSAC ? sub.p100k_sac : sub.p100k;
  return sub.p100k;
}

export function calcP100kDinamico(taxaAnual: number, prazoMeses: number, isSAC = false): number {
  if (!taxaAnual || !prazoMeses) return isSAC ? 1172 : 976;
  const i = taxaAnual / 100 / 12;
  if (isSAC) {
    // SAC: 1ª parcela = fin × (1/n + i)
    return (1 / prazoMeses + i) * 100000;
  }
  const n = prazoMeses;
  const fator = Math.pow(1 + i, n);
  return (i * fator) / (fator - 1) * 100000;
}

export function calcFGTSMax(vi: number, va: number, ato: number, fx: typeof FAIXAS[0]): number {
  const minFin = fx.sbpe ? 100000 : 50000;
  const limRegra = vi - minFin - ato;
  return Math.max(0, Math.min(va, limRegra));
}

export function pctSeguroObra(posAbsoluta: number, totalMeses: number, piso = 0.15): number {
  const terco = totalMeses / 3;
  const m = Math.min(Math.max(posAbsoluta, 1), totalMeses);
  if (m <= terco) {
    const t = terco > 1 ? (m - 1) / (terco - 1) : 1;
    return piso + t * (0.33 - piso);
  } else if (m <= terco * 2) {
    const t = terco > 1 ? (m - terco - 1) / (terco - 1) : 1;
    return 0.33 + t * (0.6666 - 0.33);
  } else {
    const t = terco > 1 ? (m - terco * 2 - 1) / (terco - 1) : 1;
    return 0.6666 + t * (0.95 - 0.6666);
  }
}

export function calcularSeguroTotal(
  fin: number, meses: number, prazoAnos: number, taxaMensal: number,
  isSAC: boolean, dtLancamento: string, dtEntrega: string
) {
  if (!fin || !meses) return { total: 0, parcelaRef: 0, limite: 0, mesesDetalhes: [], totalMesesObra: meses, obraOffset: 0 };

  const nP = prazoAnos * 12;
  let parcelaRefSeg: number;
  if (isSAC) {
    const amort = fin / nP;
    parcelaRefSeg = amort + fin * taxaMensal;
  } else {
    const coef = nP > 0 && taxaMensal > 0
      ? (taxaMensal * Math.pow(1 + taxaMensal, nP)) / (Math.pow(1 + taxaMensal, nP) - 1)
      : 1 / nP;
    parcelaRefSeg = fin * coef;
  }
  const limite = parcelaRefSeg * 0.95;

  let totalMesesObra = meses;
  let obraOffset = 0;
  if (dtLancamento && dtEntrega) {
    const lancObj = new Date(dtLancamento + 'T12:00:00');
    const entObj  = new Date(dtEntrega + 'T12:00:00');
    totalMesesObra = Math.max(meses,
      (entObj.getFullYear() - lancObj.getFullYear()) * 12 + (entObj.getMonth() - lancObj.getMonth()));
    const hoje = new Date();
    obraOffset = Math.max(0,
      (hoje.getFullYear() - lancObj.getFullYear()) * 12 + (hoje.getMonth() - lancObj.getMonth()));
  }

  const piso = 0.15;
  const tetoAbsoluto = fin * (isSAC ? 0.12 : 0.10);
  let somaTotal = 0;
  const mesesDetalhes: { m: number; valFinal: number; valDisplay: number }[] = [];

  for (let m = 1; m <= meses; m++) {
    const posAbsoluta = obraOffset + m;
    const pct = pctSeguroObra(posAbsoluta, totalMesesObra, piso);
    const valDisplay = Math.round(parcelaRefSeg * pct);
    let valFinal = valDisplay;
    if (somaTotal + valFinal > tetoAbsoluto) {
      valFinal = Math.max(0, Math.round(tetoAbsoluto - somaTotal));
    }
    somaTotal += valFinal;
    mesesDetalhes.push({ m, valFinal, valDisplay });
  }

  return { total: somaTotal, parcelaRef: parcelaRefSeg, limite, mesesDetalhes, totalMesesObra, obraOffset };
}

export function calcFinanciamentoPara(
  isSAC: boolean, vi: number, va: number, ato: number,
  renda: number, fgtsPode: boolean, fgtsDisp: number,
  fx: typeof FAIXAS[0], sub: any, parcelaSIRC: number = 0, p100kSIRC: number = 0
) {
  const pctLocal      = getPct(fx, isSAC);
  const maxFinLocal   = va * pctLocal;
  const p100kBase     = getP100k(fx, sub, isSAC);
  // SIRC usa p100k dinâmico (prazo ajustado pela obra); sem SIRC usa tabela fixa
  const p100kLocal    = p100kSIRC > 0 ? p100kSIRC : p100kBase;
  const pctRendaLocal = getPctRenda(fx, isSAC);
  const fgtsMaxLocal  = calcFGTSMax(vi, va, ato, fx);
  const fgtsUsarLocal = Math.min(fgtsPode ? fgtsDisp : 0, fgtsMaxLocal);
  const totalEntradaLocal = ato + fgtsUsarLocal;
  // SIRC override: usa parcela SIRC quando disponível, senão renda × pctRenda
  const parcelaEfetiva = parcelaSIRC > 0 ? parcelaSIRC : (renda * pctRendaLocal);
  const capTeoricaLocal = (parcelaEfetiva > 0 && p100kLocal > 0)
    ? (parcelaEfetiva / p100kLocal) * 100000
    : Infinity;
  let finLocal = Math.max(0, vi - totalEntradaLocal);
  finLocal = Math.min(finLocal, maxFinLocal, isFinite(capTeoricaLocal) ? capTeoricaLocal : finLocal);
  return {
    fin: finLocal, totalEntrada: totalEntradaLocal, fgtsUsar: fgtsUsarLocal, fgtsMax: fgtsMaxLocal,
    pct: pctLocal, p100k: p100kLocal, pctRenda: pctRendaLocal,
    // capTeorica pode ser Infinity (sem renda/parcela informada) — vira null no
    // JSON; o frontend trata null como "sem limite" na comparação de mínimos.
    capTeorica: isFinite(capTeoricaLocal) ? capTeoricaLocal : null,
    maxFin: maxFinLocal,
  };
}

export function executarSimulacao(params: {
  renda: number; vImovel: number; vAval: number; ato: number;
  fgtsPode: boolean; fgtsDisp: number; prazoAnos: number;
  mesesObra: number; tipoTaxa: string;
  dtEntrega: string; dtLancamento: string; sistemaAtivo: string;
  parcelaSIRC?: number; dataNasc?: string; residenteRegiao?: boolean;
  finManualOverride?: number;
}) {
  const { renda, vImovel, vAval, ato, fgtsPode, fgtsDisp,
          prazoAnos, mesesObra, tipoTaxa, dtEntrega, dtLancamento, sistemaAtivo } = params;
  const parcelaSIRC = params.parcelaSIRC || 0;
  const residenteRegiao = params.residenteRegiao ?? true;

  const vi = vImovel;
  const va = vAval || vi * 1.10;

  const fx  = getFaixa(renda, residenteRegiao);
  const sub = getSub(fx, renda);

  const prazoA     = Math.min(prazoAnos, 35);
  const prazoPrice = fx.sbpe ? 30 : prazoA;
  const n          = prazoA * 12;
  const nPrice     = prazoPrice * 12;
  const taxa       = (tipoTaxa === 'n' ? sub.n : sub.e) / 100 / 12;
  const taxaAnual  = tipoTaxa === 'n' ? sub.n : sub.e;

  // p100k dinâmico para SIRC: prazo máximo = 966 − idade_atual − meses_obra
  // SAC e PRICE têm fórmulas diferentes — calcula separado para cada sistema
  let p100kSIRC_SAC = 0, p100kSIRC_PRICE = 0;
  if (parcelaSIRC > 0) {
    let prazoSIRCMeses = prazoA * 12;
    if (params.dataNasc) {
      const hoje = new Date();
      const d    = new Date(params.dataNasc);
      let anos   = hoje.getFullYear() - d.getFullYear();
      let mesR   = hoje.getMonth() - d.getMonth();
      if (hoje.getDate() < d.getDate()) mesR--;
      if (mesR < 0) { anos--; mesR += 12; }
      const idadeMeses  = anos * 12 + mesR;
      const maxAjustado = Math.max(0, 966 - idadeMeses - mesesObra);
      prazoSIRCMeses    = Math.min(prazoA * 12, maxAjustado);
    }
    p100kSIRC_SAC   = calcP100kDinamico(taxaAnual, prazoSIRCMeses, true);
    p100kSIRC_PRICE = calcP100kDinamico(taxaAnual, prazoSIRCMeses, false);
  }

  // p100k dinâmico por sistema: SAC usa coef da 1ª parcela (maior) → garante 1ª SAC ≤ 30% renda
  const p100kDynSAC   = calcP100kDinamico(taxaAnual, n,      true);
  const p100kDynPRICE = calcP100kDinamico(taxaAnual, nPrice, false);
  const calcSAC   = calcFinanciamentoPara(true,  vi, va, ato, renda, fgtsPode, fgtsDisp, fx, sub, parcelaSIRC, parcelaSIRC > 0 ? p100kSIRC_SAC   : p100kDynSAC);
  const calcPRICE = calcFinanciamentoPara(false, vi, va, ato, renda, fgtsPode, fgtsDisp, fx, sub, parcelaSIRC, parcelaSIRC > 0 ? p100kSIRC_PRICE : p100kDynPRICE);
  // Variante sempre sem SIRC — usada só para o comparativo "sem restrição
  // seria X" exibido ao corretor quando o cliente tem parcela SIRC ativa.
  const calcSAC_semSIRC   = calcFinanciamentoPara(true,  vi, va, ato, renda, fgtsPode, fgtsDisp, fx, sub, 0, p100kDynSAC);
  const calcPRICE_semSIRC = calcFinanciamentoPara(false, vi, va, ato, renda, fgtsPode, fgtsDisp, fx, sub, 0, p100kDynPRICE);

  const isSACAtivo = sistemaAtivo === 'sac';

  /* ── Personalização do valor financiado ──
     O corretor pode confirmar que o banco aprovou um valor real diferente
     do calculado automaticamente. Regra: só permite AUMENTAR, em até
     R$12.000 acima do automático do sistema ativo agora — nunca reduzir,
     nunca passar do teto. Uma vez válido, o valor personalizado substitui
     finSAC/finPRICE para TODOS os cálculos derivados (tabela de
     amortização, parcela, seguro de obra) — é o mesmo empréstimo real,
     SAC/PRICE só mudam a forma de pagar, não o valor emprestado.
     calcSAC.fin / calcPRICE.fin continuam com o valor 100% automático
     (usados nos cards de FGTS/entrada/comparativo, que refletem o que o
     banco calcularia sem a confirmação manual do corretor). */
  const finAutoAtivo    = isSACAtivo ? calcSAC.fin : calcPRICE.fin;
  const FIN_MANUAL_TETO = 12000;
  let finManualAplicado: number | null = null;
  let finManualClampado = false;
  if (params.finManualOverride && params.finManualOverride > 0 && finAutoAtivo > 0) {
    const bruto = params.finManualOverride;
    const teto  = finAutoAtivo + FIN_MANUAL_TETO;
    finManualAplicado = Math.min(Math.max(bruto, finAutoAtivo), teto);
    finManualClampado = finManualAplicado !== bruto;
  }

  const finSAC   = finManualAplicado ?? calcSAC.fin;
  const finPRICE = finManualAplicado ?? calcPRICE.fin;

  /* ── Tabela SAC ── */
  const amSAC = finSAC / n;
  let sS = finSAC, tjS = 0;
  const tabelaSAC: { m: number; p: number; a: number; j: number; s: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const j = sS * taxa;
    tabelaSAC.push({ m: i, p: amSAC + j, a: amSAC, j, s: Math.max(0, sS - amSAC) });
    tjS += j; sS -= amSAC;
  }

  /* ── Tabela PRICE ── */
  const coef  = (taxa * Math.pow(1 + taxa, nPrice)) / (Math.pow(1 + taxa, nPrice) - 1);
  const pP    = finPRICE * coef;
  let sP      = finPRICE, tjP = 0;
  const tabelaPRICE: { m: number; p: number; a: number; j: number; s: number }[] = [];
  for (let i = 1; i <= nPrice; i++) {
    const j = sP * taxa, a = pP - j;
    tabelaPRICE.push({ m: i, p: pP, a, j, s: Math.max(0, sP - a) });
    tjP += j; sP -= a;
  }

  /* ── Seguro de obra ──
     finSAC/finPRICE já incorporam a personalização (se houver e válida) —
     o seguro é sempre relativo ao que será efetivamente financiado. */
  const finAtivo   = isSACAtivo ? finSAC : finPRICE;
  const segResult  = mesesObra > 0
    ? calcularSeguroTotal(finAtivo, mesesObra, prazoA, taxa, isSACAtivo, dtLancamento, dtEntrega)
    : { total: 0, parcelaRef: 0, limite: 0, mesesDetalhes: [], totalMesesObra: 0, obraOffset: 0 };

  return {
    faixa: {
      nome: fx.nome, tag: fx.tag,
      rMax: fx.rMax, iMax: fx.iMax,
      maxPct: fx.maxPct, maxPctSAC: (fx as any).maxPctSAC ?? null,
      sbpe: fx.sbpe,
    },
    sub: { n: sub.n, e: sub.e, p100k: sub.p100k, p100k_sac: (sub as any).p100k_sac ?? null },
    taxa,
    tipoTaxa,
    finSAC,   finPRICE,
    calcSAC,  calcPRICE,
    calcSAC_semSIRC, calcPRICE_semSIRC,
    finManualBase:      finAutoAtivo,
    finManualTeto:      finAutoAtivo + FIN_MANUAL_TETO,
    finManualAplicado,
    finManualClampado,
    tjS,      tjP,
    pP,
    prazoA,   prazoPrice,
    n,        nPrice,
    parcelaSAC1:   tabelaSAC[0]?.p   ?? 0,
    parcelaSACult: tabelaSAC[n - 1]?.p ?? 0,
    tabelaSAC,
    tabelaPRICE,
    seguroTotal:      segResult.total,
    seguroParcelaRef: segResult.parcelaRef,
    seguroLimite:     segResult.limite,
    seguroDetalhes:   segResult.mesesDetalhes,
    seguroTotalMeses: segResult.totalMesesObra,
    seguroOffset:     segResult.obraOffset,
  };
}

function fi2(v: number) { return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 }) }

/* ── Fluxo direto pela construtora (pré/pós-chaves) ──
   Função pura: usada tanto pelo preview ao vivo (debounce) quanto pelo
   clique em "Calcular" — fonte única, evita duplicar a fórmula no frontend. */
export function calcularConstrutora(body: any) {
  const {
    valorVenda, desconto, pctPre,
    ato,
    mensaisPreGrupos,   // [{qtd, valor}]
    anuaisPreLista,     // [{data, valor}]
    valorChaves,
    mensaisPosGrupos,   // [{qtd, valor}]
    anuaisPosLista,     // [{data, valor}]
    rendaCliente,
  } = body

  const _anuaisPre = (anuaisPreLista || []) as { data: string; valor: number }[]
  const _anuaisPos = (anuaisPosLista || []) as { data: string; valor: number }[]

  const vProposta   = Math.max(0, (valorVenda || 0) - (desconto || 0))
  const pctPreN     = Math.min(99, Math.max(1, parseFloat(pctPre) || 55))
  const pctPosN     = 100 - pctPreN
  const vPre        = Math.round(vProposta * pctPreN / 100)
  const vPos        = vProposta - vPre

  const totalMPre   = (mensaisPreGrupos || []).reduce((s: number, g: any) => s + (g.qtd || 0) * (g.valor || 0), 0)
  const totalAPre   = _anuaisPre.reduce((s, it) => s + (it.valor || 0), 0)
  const totalChaves = valorChaves || 0
  const totalPre    = (ato || 0) + totalMPre + totalAPre + totalChaves
  const saldoPre    = vPre - totalPre

  const totalMPos   = (mensaisPosGrupos || []).reduce((s: number, g: any) => s + (g.qtd || 0) * (g.valor || 0), 0)
  const totalAPos   = _anuaisPos.reduce((s, it) => s + (it.valor || 0), 0)
  const totalPos    = totalMPos + totalAPos
  const saldoPos    = vPos - totalPos

  const warnings: string[] = []
  _anuaisPre.forEach(it => {
    if (rendaCliente && it.valor > rendaCliente)
      warnings.push(`Reforço pré-chaves de ${fi2(it.valor)} (${it.data || '—'}) supera renda bruta (${fi2(rendaCliente)})`)
  })
  _anuaisPos.forEach(it => {
    if (rendaCliente && it.valor > rendaCliente)
      warnings.push(`Reforço pós-chaves de ${fi2(it.valor)} (${it.data || '—'}) supera renda bruta (${fi2(rendaCliente)})`)
  })

  const linhas: any[] = []
  if (ato) linhas.push({ tipo:'ato',      desc:'Ato (assinatura)',       qtd:1,                fase:'pré', valor:ato||0,              total:ato||0,    reajuste:'N/A' })
  ;(mensaisPreGrupos||[]).forEach((g:any,i:number) => {
    if (g.qtd && g.valor) linhas.push({ tipo:'mensal_pre', desc:`Mensais pré-chaves${i>0?' (Reforço)':''}`, qtd:g.qtd, fase:'pré', valor:g.valor, total:g.qtd*g.valor, reajuste:'INCC' })
  })
  _anuaisPre.forEach(it => {
    if (it.valor) linhas.push({ tipo:'anual_pre', desc:'Reforço pré-chaves', qtd:1, fase:'pré', valor:it.valor, total:it.valor, reajuste:'INCC', data: it.data })
  })
  if (totalChaves)
    linhas.push({ tipo:'chaves',     desc:'Parcela de chaves',       qtd:1,                fase:'pré', valor:totalChaves,       total:totalChaves,  reajuste:'INCC' })
  ;(mensaisPosGrupos||[]).forEach((g:any,i:number) => {
    if (g.qtd && g.valor) linhas.push({ tipo:'mensal_pos', desc:`Mensais pós-chaves${i>0?' (Reforço)':''}`, qtd:g.qtd, fase:'pós', valor:g.valor, total:g.qtd*g.valor, reajuste:'IGPM + PRICE' })
  })
  _anuaisPos.forEach(it => {
    if (it.valor) linhas.push({ tipo:'anual_pos', desc:'Reforço pós-chaves', qtd:1, fase:'pós', valor:it.valor, total:it.valor, reajuste:'IGPM + PRICE', data: it.data })
  })

  return { vProposta, pctPre:pctPreN, pctPos:pctPosN, vPre, vPos, totalPre, totalPos, saldoPre, saldoPos, grandTotal: totalPre + totalPos, warnings, linhas }
}

/* ── Preview ao vivo do fluxo Construtora — resolve a parcela mensal
   "automática" (M1/MP) a partir do saldo restante ÷ quantidade, e devolve
   os totais/saldos pra tela atualizar a cada tecla. Função pura, mesma
   fórmula que já existia hardcoded no app.html. ── */
export function calcularConstrutoraPreview(body: any) {
  const {
    vUnidade, desconto, pctPre, ato,
    usaG2, qtdM2, vM2, usaAP, anuaisPreLista, usaCH, vCH, qtdM1,
    usaAO, anuaisPosLista, usaG2POS, qtdM2POS, vM2POS, qtdMP,
  } = body

  const vProposta = Math.max(0, (vUnidade || 0) - (desconto || 0))
  const pctPreN   = Math.min(99, Math.max(1, parseFloat(pctPre) || 55))
  const pctPosN   = 100 - pctPreN
  const vPre      = vProposta * pctPreN / 100
  const vPos      = vProposta - vPre

  const _qtdM2  = usaG2  ? (qtdM2  || 0) : 0, _vM2  = usaG2  ? (vM2  || 0) : 0
  const _totalAP = usaAP ? (anuaisPreLista || []).reduce((s: number, it: any) => s + (it.valor || 0), 0) : 0
  const _vCH    = usaCH  ? (vCH    || 0) : 0
  const _qtdM1  = qtdM1  || 1

  const remainPre = vPre - (ato || 0) - (_qtdM2 * _vM2) - _totalAP - _vCH
  const vM1       = _qtdM1 > 0 ? Math.max(0, remainPre / _qtdM1) : 0

  const totalPre = (ato || 0) + _qtdM1 * vM1 + _qtdM2 * _vM2 + _totalAP + _vCH
  const saldoPre = Math.round(vPre - totalPre)

  const _totalAO  = usaAO ? (anuaisPosLista || []).reduce((s: number, it: any) => s + (it.valor || 0), 0) : 0
  const _qtdM2POS = usaG2POS ? (qtdM2POS || 0) : 0, _vM2POS = usaG2POS ? (vM2POS || 0) : 0
  const _qtdMP    = qtdMP    || 1

  const vMP = _qtdMP > 0 ? Math.max(0, (vPos - _totalAO - _qtdM2POS * _vM2POS) / _qtdMP) : 0

  const totalPos = _qtdMP * vMP + _totalAO + _qtdM2POS * _vM2POS
  const saldoPos = Math.round(vPos - totalPos)

  return {
    vProposta, pctPre: pctPreN, pctPos: pctPosN, vPre, vPos,
    vM1, vMP, totalPre: Math.round(totalPre), saldoPre, totalPos: Math.round(totalPos), saldoPos,
    hintM1: Math.round(_qtdM1 * vM1), hintM2: Math.round(_qtdM2 * _vM2), hintAP: Math.round(_totalAP),
    hintMP: Math.round(_qtdMP * vMP), hintM2POS: Math.round(_qtdM2POS * _vM2POS), hintAO: Math.round(_totalAO),
  }
}

/* ── Economia do programa (INCC / RGI-ITBI / Laudêmio / taxa de ligação) ──
   Função pura: percentuais e regras de composição da "economia" mostrada
   ao cliente — não pode ficar exposta em texto plano no frontend. */
export function calcularEconomia(params: {
  vf: number; vEntrega: number; mesesRestantes: number; seguro: number;
  temRgiItbi: boolean; temLaudemio: boolean; temTaxaLig: boolean;
}) {
  const { vf, vEntrega, mesesRestantes, seguro } = params
  const incc     = vf * 0.10 * (mesesRestantes / 12)          // INCC: 10% ao ano de obra restante
  const rgiItbi  = params.temRgiItbi  ? vEntrega * 0.05 : 0    // RGI/ITBI: 5% do valor de entrega
  const laudemio = params.temLaudemio ? vEntrega * 0.05 : 0    // Laudêmio: 5% do valor de entrega
  const taxaLig  = params.temTaxaLig  ? vf * 0.06 : 0          // Taxa ligação + decoração: 6% do imóvel

  const grossEconom = incc + rgiItbi + laudemio + taxaLig
  const total = grossEconom - (seguro || 0)

  return { incc, rgiItbi, laudemio, taxaLig, grossEconom, total }
}

/* ── Amortização extra (SAC/PRICE, múltiplos eventos) ──
   Função pura: dado o financiamento base e uma lista de amortizações
   extras, devolve juros com/sem amortização, timeline evento a evento
   e totais. Fonte única — evita duplicar a fórmula no frontend. */
export function calcularAmortizacao(params: {
  fin: number; prazoM: number; taxaM: number; isSAC: boolean; parcela1: number;
  lista: { parcela: number; valor: number; tipo: string }[];
}) {
  const { fin, prazoM, taxaM, isSAC, parcela1 } = params;
  const lista = [...(params.lista || [])].sort((a, b) => a.parcela - b.parcela);
  const amortM = fin / prazoM;

  for (const am of lista) {
    if (am.parcela > prazoM) {
      throw new Error(`Parcela ${am.parcela} excede o prazo de ${prazoM} meses.`);
    }
  }

  let jurosBaseline = 0;
  if (isSAC) {
    let s = fin;
    for (let i = 0; i < prazoM && s > 0.01; i++) { jurosBaseline += s * taxaM; s = Math.max(0, s - amortM); }
  } else {
    jurosBaseline = parcela1 * prazoM - fin;
  }

  let saldo = fin;
  let prazoRestante = prazoM;
  let jurosComAmort = 0;
  let totalAmortExtra = 0;
  let prevParcela = 0;
  const timeline: any[] = [];
  let quitado = false;

  for (const am of lista) {
    const steps = am.parcela - prevParcela;
    for (let i = 0; i < steps && saldo > 0.01 && prazoRestante > 0; i++) {
      jurosComAmort += saldo * taxaM;
      if (isSAC) {
        saldo = Math.max(0, saldo - amortM);
      } else {
        saldo = Math.max(0, saldo * (1 + taxaM) - parcela1);
      }
      prazoRestante--;
    }
    if (saldo <= 0.01) { quitado = true; break; }

    const prazoRestanteAntes = prazoRestante;
    const extraEfetivo = Math.min(am.valor, saldo);
    const saldoAntes = saldo;
    saldo = Math.max(0, saldo - extraEfetivo);
    totalAmortExtra += extraEfetivo;

    let prazoReduzido: number;
    if (saldo <= 0.01) {
      prazoReduzido = prazoRestante;
      prazoRestante = 0;
      quitado = true;
    } else if (isSAC) {
      const novo = Math.ceil(saldo / amortM);
      prazoReduzido = prazoRestante - novo;
      prazoRestante = novo;
    } else {
      const novo = (taxaM > 0 && (parcela1 - saldo * taxaM) > 0)
        ? Math.ceil(Math.log(parcela1 / (parcela1 - saldo * taxaM)) / Math.log(1 + taxaM))
        : prazoRestante;
      prazoReduzido = prazoRestante - novo;
      prazoRestante = novo;
    }

    const novaParcSAC = (isSAC && saldo > 0.01) ? amortM + saldo * taxaM : null;
    const novaParcPriceB = (!isSAC && saldo > 0.01 && prazoRestanteAntes > 0 && taxaM > 0)
      ? saldo * taxaM * Math.pow(1 + taxaM, prazoRestanteAntes) / (Math.pow(1 + taxaM, prazoRestanteAntes) - 1)
      : null;

    timeline.push({ parcela: am.parcela, tipo: am.tipo, valorSolicitado: am.valor, valorUsado: extraEfetivo, saldoAntes, saldoApos: saldo, prazoReduzido, novaParcSAC, novaParcPriceB, prazoMantido: prazoRestanteAntes });
    prevParcela = am.parcela;
    if (quitado) break;
  }

  while (saldo > 0.01 && prazoRestante > 0) {
    jurosComAmort += saldo * taxaM;
    if (isSAC) { saldo = Math.max(0, saldo - amortM); } else { saldo = Math.max(0, saldo * (1 + taxaM) - parcela1); }
    prazoRestante--;
  }

  const economiaTotalJuros = Math.max(0, jurosBaseline - jurosComAmort);
  const prazoReduzidoTotal = timeline.reduce((acc, t) => acc + t.prazoReduzido, 0);
  const prazoFinal = prazoM - prazoReduzidoTotal;

  return { jurosBaseline, jurosComAmort, totalAmortExtra, timeline, quitado, prazoReduzidoTotal, prazoFinal, economiaTotalJuros };
}

/* ── CORS ── */
const ALLOWED_ORIGINS = [
  'https://simulapro.app.br',
  'https://welingtonbonaeng-creator.github.io',
];
function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

// Só sobe o servidor quando o arquivo roda como entrypoint direto (deploy real).
// Isso permite importar as funções puras nos testes sem abrir porta HTTP.
if (import.meta.main) {
Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  /* ── Auth ── */
  const auth = req.headers.get('authorization');
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const token = auth.replace('Bearer ', '');
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data: { user }, error: authErr } = await sb.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Client com service role apenas para logging (sem expor ao usuário)
  const sbLog = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Enforcement do trial: roda em toda sessão (get_faixas é chamado a cada login).
  // Sem isso, todo acesso de teste concedido vira vitalício.
  const meta: any = user.user_metadata ?? {};
  if (meta.tipo === 'teste' && meta.validade) {
    const validade = new Date(meta.validade + 'T23:59:59');
    if (new Date() > validade) {
      await sbLog.auth.admin.updateUserById(user.id, { ban_duration: '87600h' });
      await sbLog.from('user_profiles').update({ status: 'bloqueado' }).eq('id', user.id);
      return new Response(JSON.stringify({ error: 'Seu período de teste expirou. Entre em contato para assinar um plano.' }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  /* ── get_faixas: retorna tabelas para UI em tempo real ──
     Se o corretor informou o município (municipioId), o teto de Faixa 1/2
     é ajustado pelo grupo MCMV real da cidade — nunca calculado no frontend. */
  if (body.action === 'get_faixas') {
    let tetoF1F2 = TETO_PADRAO_F1_F2;
    let municipio: any = null;
    if (body.municipioId) {
      const { data } = await sbLog.from('municipios_mcmv')
        .select('ibge_id, nome, uf, grupo_mcmv, teto_valor')
        .eq('ibge_id', body.municipioId)
        .maybeSingle();
      if (data) { tetoF1F2 = Number(data.teto_valor); municipio = data; }
    }
    return new Response(JSON.stringify({ FAIXAS: getFaixasComTeto(tetoF1F2), SEGURO_FAIXAS, municipio }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  /* ── buscar_municipio: autocomplete de cidade para achar o teto MCMV certo ── */
  if (body.action === 'buscar_municipio') {
    const q = (body.query || '').trim();
    if (q.length < 2) {
      return new Response(JSON.stringify({ resultados: [] }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const { data, error } = await sbLog.from('municipios_mcmv')
      .select('ibge_id, nome, uf, grupo_mcmv, teto_valor')
      .ilike('nome', `%${q}%`)
      .order('populacao', { ascending: false })
      .limit(8);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ resultados: data }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  /* ── simular: cálculo principal ── */
  if (body.action === 'simular') {
    try {
      const result = executarSimulacao(body);
      await sbLog.from('events').insert({
        user_id: user.id,
        email: user.email,
        action: 'simulacao',
        details: { t:'caixa', faixa: result.faixa?.tag ?? '—', vi: body.vImovel ?? 0 },
      });
      return new Response(JSON.stringify(result),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  /* ── preview: mesma fórmula do 'simular', chamada em debounce a cada
     digitação para alimentar os cards de capacidade/entrada/seguro em
     tempo real — sem logar evento de analytics a cada tecla. ── */
  if (body.action === 'preview') {
    try {
      const result = executarSimulacao(body);
      return new Response(JSON.stringify(result),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  /* ── amortizar: simulador de amortização extra (SAC/PRICE) ── */
  if (body.action === 'amortizar') {
    const { fin, prazoM, taxaM, isSAC, parcela1, lista } = body;
    if (!fin || !prazoM || !Array.isArray(lista) || !lista.length) {
      return new Response(JSON.stringify({ error: 'Dados insuficientes para calcular a amortização.' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    try {
      const result = calcularAmortizacao({ fin, prazoM, taxaM, isSAC, parcela1, lista });
      await sbLog.from('events').insert({
        user_id: user.id,
        email: user.email,
        action: 'amortizacao',
        details: { eventos: lista.length, totalAmort: Math.round(result.totalAmortExtra), economiaJuros: Math.round(result.economiaTotalJuros) },
      });
      return new Response(JSON.stringify(result),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  /* ── simular_construtora: fluxo direto pela construtora ── */
  if (body.action === 'simular_construtora' || body.action === 'preview_construtora') {
    const payload = calcularConstrutora(body)
    if (body.action === 'simular_construtora') {
      await sbLog.from('events').insert({
        user_id: user.id,
        email: user.email,
        action: 'simulacao_construtora',
        details: { t:'construtora', vi: body.valorVenda ?? 0, pctPre: payload.pctPre },
      });
    }
    return new Response(JSON.stringify(payload), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* ── preview_construtora_live: resolve M1/MP e saldos a cada tecla ── */
  if (body.action === 'preview_construtora_live') {
    const payload = calcularConstrutoraPreview(body)
    return new Response(JSON.stringify(payload), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* ── calc_economia: INCC / RGI-ITBI / Laudêmio / taxa de ligação ── */
  if (body.action === 'calc_economia') {
    const payload = calcularEconomia(body)
    return new Response(JSON.stringify(payload), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  /* ── calc_valorizacao: lucro estimado ── */
  if (body.action === 'calc_valorizacao') {
    const { vi, fin, pctValorizacao, seguroTotal } = body;
    if (!vi || fin == null) return new Response(JSON.stringify({ error: 'vi e fin obrigatórios' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    const pct         = Math.max(1, parseFloat(pctValorizacao) || 60) / 100;
    const entradaTotal = vi - fin;
    const valorFuturo  = vi * (1 + pct);
    const lucro        = valorFuturo - vi - (seguroTotal || 0);
    return new Response(JSON.stringify({ entradaTotal, valorFuturo, lucro }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Ação desconhecida' }),
    { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
}
