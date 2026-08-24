/* Vencimento REAL de uma assinatura — NÃO é o `nextDueDate` da assinatura
   na Asaas. Esse campo avança pro ciclo seguinte assim que a Asaas pré-gera
   a próxima fatura (dias antes do vencimento), independente de a fatura
   atual já ter sido paga — então pode apontar um ciclo inteiro à frente de
   uma cobrança pendente/vencida ainda em aberto (achado real: assinatura
   com fatura de R$70 PENDING vencendo dia X, mas nextDueDate já em X+1 mês).
   Aqui usamos a fatura pendente/vencida mais próxima como vencimento real;
   só cai pro nextDueDate da assinatura quando não há nenhuma fatura em
   aberto (tudo pago, sem gap de cobrança). Módulo isolado (sem import de
   SDKs) pra poder ser testado sem subir o resto da Edge Function. */
export function escolherVencimentoReal(
  pagamentos: { status: string; dueDate: string }[],
  nextDueDateFallback: string | null,
): string | null {
  const emAberto = pagamentos
    .filter(p => p.status === 'PENDING' || p.status === 'OVERDUE')
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
  if (emAberto.length > 0) return emAberto[0].dueDate
  return nextDueDateFallback
}

/* Tolerância de acesso após o vencimento: cliente atrasado continua
   usando o app por GRACE_DIAS_ATRASO dias, vendo aviso com contagem
   regressiva a cada acesso. No último dia dispara e-mail (ver cron
   `check_atraso_avisos`). Depois disso, acesso bloqueado até pagar —
   sem banir a conta, só trava o uso dentro do próprio app. */
export const GRACE_DIAS_ATRASO = 3

export interface AtrasoInfo {
  diasAtraso: number
  diasRestantes: number
  ultimoDia: boolean
  bloqueado: boolean
}

export function calcAtrasoInfo(proximoVencimento: string | null, hojeISO: string): AtrasoInfo {
  if (!proximoVencimento) {
    return { diasAtraso: 0, diasRestantes: GRACE_DIAS_ATRASO, ultimoDia: false, bloqueado: false }
  }
  const venc = new Date(proximoVencimento + 'T00:00:00Z').getTime()
  const hoje = new Date(hojeISO + 'T00:00:00Z').getTime()
  const diasAtraso = Math.max(0, Math.round((hoje - venc) / 86400000))
  const diasRestantes = Math.max(0, GRACE_DIAS_ATRASO - diasAtraso)
  return {
    diasAtraso,
    diasRestantes,
    ultimoDia: diasAtraso === GRACE_DIAS_ATRASO,
    bloqueado: diasAtraso > GRACE_DIAS_ATRASO,
  }
}

/* Acesso de teste: SEM tolerância extra — vale exatamente os dias que o
   admin definiu na validade (`solicitacoes_teste.validade`). Avisa com
   contagem regressiva nos últimos JANELA_AVISO_TRIAL dias; no dia exato
   do vencimento ainda usa (é o último dia, dispara e-mail — ver cron
   `check_trial_expirations`); a partir do dia seguinte, bloqueado e
   direcionado pra tela de planos. Fonte única de verdade é
   `solicitacoes_teste`, nunca `user_metadata` (não fica sincronizado). */
export const JANELA_AVISO_TRIAL = 3

export interface TrialInfo {
  diasRestantes: number
  avisar: boolean
  ultimoDia: boolean
  vencido: boolean
}

export function calcTrialInfo(validade: string | null, hojeISO: string): TrialInfo | null {
  if (!validade) return null
  const venc = new Date(validade + 'T00:00:00Z').getTime()
  const hoje = new Date(hojeISO + 'T00:00:00Z').getTime()
  const diasRestantes = Math.round((venc - hoje) / 86400000)
  return {
    diasRestantes,
    avisar: diasRestantes >= 0 && diasRestantes <= JANELA_AVISO_TRIAL,
    ultimoDia: diasRestantes === 0,
    vencido: diasRestantes < 0,
  }
}
