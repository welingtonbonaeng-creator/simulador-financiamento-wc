import { createClient } from 'npm:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = [
  'https://simulapro.app.br',
  'https://welingtonbonaeng-creator.github.io',
]
let CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function sendBrevo(apiKey: string, to: string, toName: string, subject: string, html: string) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: 'simulador.wc@gmail.com', name: 'SimulaPro' },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent: html,
    }),
  })
  return r.ok
}

const APP = 'https://simulapro.app.br'
const TERMOS_VERSAO = '1.0'

function clientIp(req: Request) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? null
}

async function registrarAceiteTermos(sb: any, userId: string, email: string, ip: string | null, userAgent: string | null) {
  await sb.from('termos_aceites').insert({ user_id: userId, email, versao: TERMOS_VERSAO, ip, user_agent: userAgent })
}

// ── ASAAS — planos e helpers ──────────────────────────────────
// Chave e ambiente ficam só em secrets da Edge Function (nunca no frontend).
const ASAAS_PLANOS: Record<string, { value: number; cycle: string; descricao: string }> = {
  mensal: { value: 70,  cycle: 'MONTHLY', descricao: 'SimulaPro — Plano Mensal' },
  anual:  { value: 600, cycle: 'YEARLY',  descricao: 'SimulaPro — Plano Anual' },
}

function asaasBase() {
  const env = Deno.env.get('ASAAS_ENV') ?? 'sandbox'
  return env === 'production' ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3'
}

async function asaasFetch(path: string, opts: RequestInit = {}) {
  const key = Deno.env.get('ASAAS_API_KEY') ?? ''
  const r = await fetch(`${asaasBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'access_token': key,
      ...(opts.headers || {}),
    },
  })
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, data }
}

function gerarSenha() {
  return Math.random().toString(36).slice(-8) + Math.floor(Math.random() * 100)
}

// Senha provisória — charset sem caracteres ambíguos (0/O, 1/l/I), aleatoriedade
// criptográfica (crypto.getRandomValues, não Math.random) por ser enviada por e-mail
// e servir de credencial de login, ainda que de uso único.
function gerarSenhaProvisoria() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += chars[bytes[i] % chars.length]
  return s
}

Deno.serve(async (req: Request) => {
  const reqOrigin = req.headers.get('origin')
  CORS = {
    ...CORS,
    'Access-Control-Allow-Origin': (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) ? reqOrigin : ALLOWED_ORIGINS[0],
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const SURL  = Deno.env.get('SUPABASE_URL') ?? ''
    const ANON  = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const SRK   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const BREVO = Deno.env.get('BREVO_API_KEY') ?? ''

    const sb   = createClient(SURL, SRK)

    // ── WEBHOOK ASAAS (chamado pela Asaas, não pelo app) ──────
    // Identificado pelo header próprio da Asaas, autenticado por token
    // configurado no painel da Asaas + guardado como secret (nunca no frontend).
    const asaasHeaderToken = req.headers.get('asaas-access-token')
    if (asaasHeaderToken !== null) {
      const expected = Deno.env.get('ASAAS_WEBHOOK_TOKEN') ?? ''
      if (!expected || asaasHeaderToken !== expected) {
        return json({ error: 'Token de webhook inválido' }, 401)
      }

      const evt: any = await req.json().catch(() => ({}))
      const eventName: string = evt.event ?? ''
      const payment = evt.payment ?? {}
      const subscriptionId: string | undefined = payment.subscription

      if (subscriptionId) {
        const { data: assinatura } = await sb
          .from('asaas_assinaturas')
          .select('*')
          .eq('asaas_subscription_id', subscriptionId)
          .maybeSingle()

        if (assinatura) {
          if (eventName === 'PAYMENT_CONFIRMED' || eventName === 'PAYMENT_RECEIVED') {
            const subInfo = await asaasFetch(`/subscriptions/${subscriptionId}`)
            const proximoVenc = subInfo.ok ? (subInfo.data?.nextDueDate ?? null) : null

            if (!assinatura.user_id) {
              // primeiro pagamento confirmado → cria o acesso do corretor
              const senha = gerarSenha()
              const { data: nu, error: ce } = await sb.auth.admin.createUser({
                email: assinatura.email,
                password: senha,
                email_confirm: true,
                user_metadata: { nome: assinatura.nome, tipo: 'corretor', origem: 'asaas' },
              })
              if (!ce && nu.user) {
                await sb.from('user_profiles').insert({
                  id: nu.user.id,
                  email: assinatura.email,
                  nome: assinatura.nome,
                  status: 'ativo',
                  plano: assinatura.plano,
                })
                await sb.from('asaas_assinaturas').update({
                  user_id: nu.user.id,
                  status: 'ativo',
                  invoice_url: null,
                  proximo_vencimento: proximoVenc,
                  atualizado_em: new Date().toISOString(),
                }).eq('id', assinatura.id)

                // Registra o aceite dos Termos com o timestamp real do checkout
                // (momento em que o consentimento foi de fato dado), não o de agora.
                await sb.from('termos_aceites').insert({
                  user_id: nu.user.id, email: assinatura.email, versao: TERMOS_VERSAO,
                  aceito_em: assinatura.termos_aceito_em ?? new Date().toISOString(),
                  ip: assinatura.termos_ip, user_agent: assinatura.termos_user_agent,
                })

                if (BREVO) {
                  await sendBrevo(BREVO, assinatura.email, assinatura.nome,
                    'Seu acesso ao SimulaPro está liberado!',
                    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
                      <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
                        <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
                        <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
                      </div>
                      <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
                        <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${assinatura.nome}!</p>
                        <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu pagamento foi confirmado e seu acesso ao SimulaPro já está liberado.</p>
                        <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 20px;font-family:monospace">
                          <p style="margin:4px 0;font-size:14px"><strong>E-mail:</strong> ${assinatura.email}</p>
                          <p style="margin:4px 0;font-size:14px"><strong>Senha:</strong> ${senha}</p>
                        </div>
                        <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
                      </div>
                    </div>`
                  )
                }
              } else if (ce && /already been registered|already registered/i.test(ce.message ?? '')) {
                // E-mail já tem conta no SimulaPro (trial antigo, conta criada manualmente,
                // etc.) — não mescla nem cria nada sozinho. Só avisa o cliente que pagou,
                // pra ele mesmo entrar/renovar na conta que já existe.
                await sb.from('events').insert({
                  user_id: null, email: assinatura.email, action: 'asaas_email_duplicado',
                  details: { assinaturaId: assinatura.id, subscriptionId },
                })
                if (BREVO) {
                  await sendBrevo(BREVO, assinatura.email, assinatura.nome,
                    'Seu pagamento foi confirmado — você já tem uma conta no SimulaPro',
                    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
                      <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
                        <h2 style="color:#fff;margin:0 0 6px;font-size:20px">SimulaPro</h2>
                        <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
                      </div>
                      <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
                        <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Ola, ${assinatura.nome}!</p>
                        <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6">Seu pagamento foi confirmado. Identificamos que este e-mail (${assinatura.email}) ja tem uma conta no SimulaPro.</p>
                        <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Entre normalmente com essa conta pra renovar seu acesso. Esqueceu a senha? Use "Esqueci minha senha" na tela de login. Se precisar de ajuda, responda este e-mail.</p>
                        <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Fazer login</a>
                      </div>
                    </div>`
                  )
                }
              }
            } else {
              // renovação — garante que o acesso está ativo (nunca banido por atraso)
              await sb.auth.admin.updateUserById(assinatura.user_id, { ban_duration: 'none' })
              await sb.from('user_profiles').update({ status: 'ativo' }).eq('id', assinatura.user_id)
              await sb.from('asaas_assinaturas').update({
                status: 'ativo', invoice_url: null, proximo_vencimento: proximoVenc,
                atualizado_em: new Date().toISOString(),
              }).eq('id', assinatura.id)
            }
          } else if (eventName === 'PAYMENT_OVERDUE') {
            // Atraso: NÃO bane o login — o corretor precisa conseguir entrar
            // no app para ver o aviso de renovação e o link de pagamento.
            if (assinatura.user_id) {
              await sb.from('user_profiles').update({ status: 'atrasado' }).eq('id', assinatura.user_id)
            }
            await sb.from('asaas_assinaturas').update({
              status: 'atrasado', invoice_url: payment.invoiceUrl ?? null,
              atualizado_em: new Date().toISOString(),
            }).eq('id', assinatura.id)
          } else if (eventName === 'SUBSCRIPTION_DELETED' || eventName === 'PAYMENT_DELETED' || eventName === 'PAYMENT_REFUNDED') {
            // Cancelamento de fato — aí sim bloqueia o acesso completamente.
            if (assinatura.user_id) {
              await sb.auth.admin.updateUserById(assinatura.user_id, { ban_duration: '87600h' })
              await sb.from('user_profiles').update({ status: 'bloqueado' }).eq('id', assinatura.user_id)
            }
            await sb.from('asaas_assinaturas').update({
              status: 'cancelado', invoice_url: null, atualizado_em: new Date().toISOString(),
            }).eq('id', assinatura.id)
          }
        }
      }

      // Sempre responde 200 rápido pra Asaas não ficar retentando
      return json({ received: true })
    }

    const body = await req.json()
    const action  = body.action ?? ''
    const payload = body.payload ?? {}

    // ── AÇÃO PÚBLICA: forgot_password (sem autenticação) ──────
    // Em vez do link de recovery nativo do Supabase (limite de e-mail baixo,
    // e não resolvia "esqueceu a senha, mas trocar senha pede a senha atual"),
    // emite uma senha provisória de uso único por e-mail. Resposta é sempre
    // genérica (não revela se o e-mail existe, está bloqueado, ou foi limitado).
    if (action === 'forgot_password') {
      const email = String(payload.email ?? '').trim().toLowerCase()
      const generic = { success: true, msg: 'Se este e-mail estiver cadastrado, você vai receber uma senha provisória em instantes.' }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(generic)

      const ip = clientIp(req) ?? 'desconhecido'
      const janela = new Date(Date.now() - 15 * 60 * 1000).toISOString()

      const { count: tentativasEmail } = await sb.from('events').select('*', { count: 'exact', head: true })
        .eq('action', 'forgot_password_requested').eq('email', email).gte('created_at', janela)
      const { count: tentativasIp } = await sb.from('events').select('*', { count: 'exact', head: true })
        .eq('action', 'forgot_password_requested').contains('details', { ip }).gte('created_at', janela)

      // Loga a tentativa sempre — inclusive as barradas — é o que alimenta o rate limit
      await sb.from('events').insert({ email, action: 'forgot_password_requested', details: { ip }, user_agent: 'forgot_password' })

      if ((tentativasEmail ?? 0) >= 1 || (tentativasIp ?? 0) >= 5) return json(generic)

      const { data: perfil } = await sb.from('user_profiles').select('id, nome, status').eq('email', email).maybeSingle()
      if (!perfil || perfil.status === 'bloqueado') return json(generic)

      const senhaProvisoria = gerarSenhaProvisoria()
      const { error: pe } = await sb.auth.admin.updateUserById(perfil.id, { password: senhaProvisoria })
      if (pe) return json(generic)

      await sb.from('user_profiles').update({ must_change_password: true }).eq('id', perfil.id)
      await sb.from('events').insert({ user_id: perfil.id, email, action: 'forgot_password_issued', details: { ip }, user_agent: 'forgot_password' })

      if (BREVO) {
        await sendBrevo(BREVO, email, perfil.nome || email,
          'Sua senha provisória do SimulaPro',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🔑 SimulaPro</h2>
              <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Redefinição de senha</p>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${perfil.nome || ''}!</p>
              <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6">Geramos uma senha provisória pra você entrar no SimulaPro. Use ela pra fazer login — na hora, o app vai pedir pra você escolher sua senha definitiva.</p>
              <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 16px;font-family:monospace;text-align:center">
                <p style="margin:0;font-size:20px;font-weight:700;letter-spacing:1px;color:#0B3D91">${senhaProvisoria}</p>
              </div>
              <p style="margin:0 0 20px;font-size:12.5px;color:#991B1B;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 12px;line-height:1.5">⚠️ Essa senha é provisória: assim que você entrar, o app já vai pedir pra você escolher sua senha definitiva — e essa senha temporária deixa de existir. Entre logo em seguida e complete a troca.</p>
              <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
            </div>
          </div>`
        )
      }

      return json(generic)
    }

    // ── AÇÃO PÚBLICA: asaas_checkout (sem autenticação) ───────
    // Só fala com a Asaas pelo backend — a API key nunca chega no navegador.
    if (action === 'asaas_checkout') {
      const { nome, email, cpfCnpj, telefone, plano, aceitouTermos } = payload
      if (!nome || !email || !cpfCnpj || !plano) {
        return json({ error: 'nome, email, cpfCnpj e plano são obrigatórios' }, 400)
      }
      if (aceitouTermos !== true) {
        return json({ error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade.' }, 400)
      }
      const planoCfg = ASAAS_PLANOS[plano]
      if (!planoCfg) return json({ error: 'plano inválido' }, 400)
      if (!Deno.env.get('ASAAS_API_KEY')) return json({ error: 'Pagamentos ainda não configurados' }, 503)

      // Cupom de desconto (opcional): sobrescreve o valor do plano se válido.
      let valorFinal = planoCfg.value
      let cupomRow: any = null
      if (payload.cupom) {
        const codigo = String(payload.cupom).trim().toUpperCase()
        const { data: c } = await sb.from('cupons').select('*').eq('codigo', codigo).eq('ativo', true).maybeSingle()
        if (!c) return json({ error: 'Cupom inválido.' }, 400)
        if (c.plano !== plano && c.plano !== 'todos') {
          return json({ error: 'Este cupom não é válido para o plano selecionado.' }, 400)
        }
        const hoje = new Date().toISOString().slice(0, 10)
        if (c.valido_ate < hoje) return json({ error: 'Este cupom expirou.' }, 400)
        if (c.max_usos !== null && c.usos_atuais >= c.max_usos) {
          return json({ error: 'Este cupom já atingiu o limite de usos.' }, 400)
        }
        valorFinal = parseFloat(c.valor_com_cupom)
        cupomRow = c
      }

      const cpfLimpo = String(cpfCnpj).replace(/\D/g, '')

      // Já existe uma CONTA no SimulaPro com esse e-mail (trial, criada manualmente,
      // ou de uma assinatura anterior)? Não deixa criar conta duplicada — o cliente
      // deve entrar na conta que já existe pra renovar o acesso.
      const { data: perfilExistente } = await sb.from('user_profiles')
        .select('id, status').eq('email', email).maybeSingle()
      if (perfilExistente) {
        return json({ error: 'Este e-mail já tem uma conta no SimulaPro. Faça login pra renovar seu acesso — se esqueceu a senha, use "Esqueci minha senha" na tela de login.' }, 409)
      }

      // Evita assinatura duplicada: já existe uma pendente ou ativa pra esse e-mail OU esse CPF?
      const { data: existente } = await sb.from('asaas_assinaturas')
        .select('*').or(`email.eq.${email},cpf.eq.${cpfLimpo}`).in('status', ['pendente', 'ativo'])
        .order('criado_em', { ascending: false }).maybeSingle()
      if (existente?.status === 'ativo') {
        return json({ error: 'Já existe uma assinatura ativa com esse e-mail ou CPF. Faça login pra renovar seu acesso, ou fale com o suporte se precisar de ajuda.' }, 409)
      }
      if (existente?.status === 'pendente') {
        // Já tinha começado o checkout e não pagou ainda — reenvia o mesmo link em vez de duplicar.
        const pagamentosExistentes = await asaasFetch(`/payments?subscription=${existente.asaas_subscription_id}`)
        const linkExistente = pagamentosExistentes.data?.data?.[0]?.invoiceUrl
        if (linkExistente) return json({ checkoutUrl: linkExistente })
        // Se não achou o pagamento (raro), segue o fluxo normal e cria um novo.
      }

      // Reaproveita cliente Asaas existente pelo e-mail, se houver
      const busca = await asaasFetch(`/customers?email=${encodeURIComponent(email)}`)
      let customerId = busca.ok && busca.data.data?.[0]?.id
      if (!customerId) {
        const criado = await asaasFetch('/customers', {
          method: 'POST',
          body: JSON.stringify({ name: nome, email, cpfCnpj, mobilePhone: telefone }),
        })
        if (!criado.ok) return json({ error: criado.data?.errors?.[0]?.description || 'Erro ao criar cliente na Asaas' }, 400)
        customerId = criado.data.id
      }

      const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      const sub = await asaasFetch('/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          customer: customerId,
          billingType: 'UNDEFINED',
          value: valorFinal,
          cycle: planoCfg.cycle,
          nextDueDate: amanha,
          description: cupomRow ? `${planoCfg.descricao} (cupom ${cupomRow.codigo})` : planoCfg.descricao,
        }),
      })
      if (!sub.ok) return json({ error: sub.data?.errors?.[0]?.description || 'Erro ao criar assinatura na Asaas' }, 400)

      if (cupomRow) {
        await sb.from('cupons').update({ usos_atuais: cupomRow.usos_atuais + 1 }).eq('id', cupomRow.id)
      }

      const pagamentos = await asaasFetch(`/payments?subscription=${sub.data.id}`)
      const checkoutUrl = pagamentos.data?.data?.[0]?.invoiceUrl

      const { error: insErr } = await sb.from('asaas_assinaturas').insert({
        asaas_customer_id: customerId,
        asaas_subscription_id: sub.data.id,
        email, nome, telefone, cpf: cpfLimpo,
        plano, valor: valorFinal,
        cupom_usado: cupomRow?.codigo ?? null,
        status: 'pendente',
        termos_aceito_em: new Date().toISOString(),
        termos_ip: clientIp(req),
        termos_user_agent: payload.userAgent ?? null,
      })
      if (insErr) {
        console.error('erro ao salvar asaas_assinaturas:', insErr.message)
        return json({ error: 'Assinatura criada na Asaas, mas houve erro ao salvar no sistema: ' + insErr.message }, 500)
      }

      if (!checkoutUrl) return json({ error: 'Assinatura criada, mas sem link de pagamento — verifique o painel Asaas' }, 500)
      return json({ checkoutUrl })
    }

    // ── AÇÃO PÚBLICA: validar_cupom (sem autenticação) ────────
    // Só confere se o cupom é válido pro plano e devolve o preço com
    // desconto — pra mostrar na tela antes do corretor preencher tudo,
    // evitando surpresa (achar que vai pagar R$70 e só saber na Asaas).
    if (action === 'validar_cupom') {
      const { codigo, plano } = payload
      if (!codigo || !plano) return json({ error: 'codigo e plano obrigatórios' }, 400)
      const codigoNorm = String(codigo).trim().toUpperCase()
      const { data: c } = await sb.from('cupons').select('*').eq('codigo', codigoNorm).eq('ativo', true).maybeSingle()
      if (!c) return json({ error: 'Cupom inválido.' }, 404)
      if (c.plano !== plano && c.plano !== 'todos') return json({ error: 'Este cupom não vale para este plano.' }, 400)
      const hoje = new Date().toISOString().slice(0, 10)
      if (c.valido_ate < hoje) return json({ error: 'Este cupom expirou.' }, 400)
      if (c.max_usos !== null && c.usos_atuais >= c.max_usos) return json({ error: 'Este cupom já atingiu o limite de usos.' }, 400)
      return json({ valido: true, valor: parseFloat(c.valor_com_cupom), codigo: codigoNorm })
    }

    // ── AÇÃO PÚBLICA: submit_request (sem autenticação) ───────
    // Provisiona o acesso de teste na hora — sem aprovação manual do admin.
    // O corretor pede às 22h de sábado e já recebe a senha no mesmo minuto.
    if (action === 'submit_request') {
      const { nome, email, telefone, aceitouTermos } = payload
      if (!nome || !email) return json({ error: 'nome e email obrigatórios' }, 400)
      if (aceitouTermos !== true) {
        return json({ error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade.' }, 400)
      }

      // Rate limit por IP — sem isso, dá pra criar conta real + mandar e-mail
      // com senha de verdade pra qualquer endereço em massa (spam/harassment,
      // além de estourar a cota diária da Brevo e travar todo e-mail do negócio).
      const ipSubmit = clientIp(req) ?? 'desconhecido'
      const janelaSubmit = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count: tentativasIpSubmit } = await sb.from('events').select('*', { count: 'exact', head: true })
        .eq('action', 'submit_request_attempt').contains('details', { ip: ipSubmit }).gte('created_at', janelaSubmit)
      await sb.from('events').insert({ email, action: 'submit_request_attempt', details: { ip: ipSubmit }, user_agent: 'submit_request' })
      if ((tentativasIpSubmit ?? 0) >= 3) {
        return json({ error: 'Muitas solicitações deste endereço. Tente novamente mais tarde ou fale com a gente pelo WhatsApp.' }, 429)
      }

      // anti-abuso: já existe pedido de teste com este e-mail?
      const { data: existente } = await sb.from('solicitacoes_teste').select('id').eq('email', email).maybeSingle()
      if (existente) {
        return json({ error: 'Este e-mail já solicitou um teste antes. Verifique sua caixa de entrada ou fale com a gente pelo WhatsApp.' }, 409)
      }

      const { data: cfg } = await sb.from('app_config').select('trial_dias').eq('id', 1).maybeSingle()
      const trialDias = cfg?.trial_dias ?? 7

      const senha = gerarSenha()
      const validade = new Date(); validade.setDate(validade.getDate() + trialDias)
      const validadeStr = validade.toISOString().slice(0, 10)

      const { data: nu, error: ce } = await sb.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, tipo: 'teste', validade: validadeStr },
      })
      if (ce) {
        const jaExiste = /already.*registered|already.*exists/i.test(ce.message)
        return json({ error: jaExiste ? 'Este e-mail já tem uma conta no SimulaPro.' : ce.message }, 400)
      }

      await sb.from('user_profiles').insert({ id: nu.user!.id, email, nome, status: 'ativo' })

      await sb.from('solicitacoes_teste').insert({
        nome, email, telefone,
        status: 'aprovado',
        user_id: nu.user!.id,
        aprovado_em: new Date().toISOString(),
        senha_inicial: senha,
        validade: validadeStr,
      })

      await registrarAceiteTermos(sb, nu.user!.id, email, clientIp(req), payload.userAgent ?? null)

      await sb.from('events').insert({
        user_id: nu.user!.id, email, action: 'trial_auto_criado',
        details: { trial_dias: trialDias, validade: validadeStr },
      })

      // credenciais para o corretor
      if (BREVO) {
        const validadeFmt = validade.toLocaleDateString('pt-BR')
        await sendBrevo(BREVO, email, nome,
          'Seu acesso de teste ao SimulaPro está pronto!',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
              <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${nome}!</p>
              <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu acesso de teste ao SimulaPro já está liberado. Use as credenciais abaixo para entrar agora.</p>
              <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 20px;font-family:monospace">
                <p style="margin:4px 0;font-size:14px"><strong>E-mail:</strong> ${email}</p>
                <p style="margin:4px 0;font-size:14px"><strong>Senha:</strong> ${senha}</p>
                <p style="margin:8px 0 0;font-size:12px;color:#64748B">⏱️ Acesso válido por <strong>${trialDias} dias</strong> — até ${validadeFmt}</p>
              </div>
              <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
              <p style="margin:16px 0 0;font-size:12px;color:#94A3B8;text-align:center">Dúvidas? Responda este e-mail ou entre em contato pelo WhatsApp.</p>
            </div>
          </div>`
        )

        // aviso informativo pro admin (não precisa agir)
        await sendBrevo(
          BREVO, 'simulador.wc@gmail.com', 'Well — SimulaPro Admin',
          `Novo teste criado automaticamente — ${nome}`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:#0B3D91;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#fff;margin:0;font-size:16px">🧪 Novo Teste Criado Automaticamente</h2>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:20px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 12px;font-size:14px">Acesso já liberado e enviado — nenhuma ação necessária.</p>
              <div style="background:#F4F6FA;border-radius:8px;padding:16px;font-size:14px">
                <p style="margin:4px 0"><strong>Nome:</strong> ${nome}</p>
                <p style="margin:4px 0"><strong>E-mail:</strong> ${email}</p>
                <p style="margin:4px 0"><strong>Telefone:</strong> ${telefone || '—'}</p>
                <p style="margin:4px 0"><strong>Válido até:</strong> ${validadeFmt}</p>
              </div>
              <a href="${APP}/admin.html" style="display:inline-block;margin-top:12px;background:#0B3D91;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">Abrir Painel Admin →</a>
            </div>
          </div>`
        )
      }

      return json({ success: true })
    }

    // ── CRON: CHECK_TRIAL_EXPIRATIONS (chamado pelo pg_cron, não por usuário) ──
    // Roda 1x/dia. Acha trials vencidos, bloqueia acesso e manda e-mail
    // direcionando pra página de pagamento — mesmo que o corretor nunca
    // mais tente logar (senão só descobriríamos no próximo login dele).
    if (action === 'check_trial_expirations') {
      const cronToken = req.headers.get('x-cron-token')
      const expectedCron = Deno.env.get('CRON_SECRET') ?? ''
      if (!expectedCron || cronToken !== expectedCron) return json({ error: 'Token invalido' }, 401)

      const { data: listData, error: le } = await sb.auth.admin.listUsers({ perPage: 1000 })
      if (le) return json({ error: le.message }, 500)

      const hoje = new Date().toISOString().slice(0, 10)
      let notificados = 0

      for (const u of listData.users) {
        const meta: any = u.user_metadata ?? {}
        if (meta.tipo !== 'teste' || !meta.validade || meta.trial_notificado) continue
        if (meta.validade > hoje) continue

        await sb.auth.admin.updateUserById(u.id, {
          ban_duration: '87600h',
          user_metadata: { ...meta, trial_notificado: true },
        })
        await sb.from('user_profiles').update({ status: 'bloqueado' }).eq('id', u.id)
        await sb.from('events').insert({ user_id: u.id, email: u.email, action: 'trial_expirado_notificado' })

        if (BREVO && u.email) {
          await sendBrevo(BREVO, u.email, meta.nome || u.email,
            'Seu teste do SimulaPro terminou',
            `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
                <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
              </div>
              <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
                <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${meta.nome || ''}!</p>
                <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu período de teste no SimulaPro chegou ao fim. Pra continuar usando sem perder o embalo, escolha um plano abaixo — leva menos de 2 minutos.</p>
                <a href="${APP}/vendas.html#preco" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Ver planos e assinar →</a>
                <p style="margin:16px 0 0;font-size:12px;color:#94A3B8;text-align:center">Dúvidas? Responda este e-mail ou chama no WhatsApp.</p>
              </div>
            </div>`
          )
        }
        notificados++
      }

      return json({ success: true, notificados })
    }

    // ── A PARTIR DAQUI: requer autenticação ───────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Nao autorizado' }, 401)

    const caller = createClient(SURL, ANON, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: ue } = await caller.auth.getUser()
    if (ue || !user) return json({ error: 'Sessao invalida' }, 401)

    // check_admin: qualquer usuário autenticado pode verificar seu próprio status
    if (action === 'check_admin') {
      const { data: adminRow } = await sb.from('admins').select('id').eq('user_id', user.id).maybeSingle()
      return json({ isAdmin: !!adminRow })
    }

    // get_my_status: qualquer usuário autenticado vê a própria assinatura
    // (usado pelo app.html para mostrar aviso de renovação, sem precisar ser admin)
    if (action === 'get_my_status') {
      const { data: perfil } = await sb.from('user_profiles').select('status, plano, must_change_password').eq('id', user.id).maybeSingle()
      const { data: assinatura } = await sb.from('asaas_assinaturas')
        .select('plano, valor, status, invoice_url, proximo_vencimento')
        .eq('user_id', user.id).maybeSingle()
      const { data: termo } = await sb.from('termos_aceites')
        .select('id').eq('user_id', user.id).eq('versao', TERMOS_VERSAO).maybeSingle()
      return json({
        status: perfil?.status ?? 'ativo', plano: perfil?.plano ?? null, assinatura: assinatura ?? null,
        termosAceitos: !!termo, termosVersao: TERMOS_VERSAO,
        mustChangePassword: !!perfil?.must_change_password,
      })
    }

    // aceitar_termos: qualquer usuário autenticado registra o aceite dos
    // Termos de Uso / Política de Privacidade vigentes (prova de consentimento LGPD)
    if (action === 'aceitar_termos') {
      await registrarAceiteTermos(sb, user.id, user.email!, clientIp(req), payload.userAgent ?? null)
      return json({ success: true })
    }

    // change_password: qualquer usuário autenticado troca a própria senha
    // (o app.html já validou a senha atual reautenticando antes de chamar isso)
    if (action === 'change_password') {
      const { novaSenha } = payload
      if (!novaSenha || novaSenha.length < 6) return json({ error: 'A nova senha deve ter pelo menos 6 caracteres' }, 400)

      const { error: pe } = await sb.auth.admin.updateUserById(user.id, { password: novaSenha })
      if (pe) return json({ error: pe.message }, 400)

      await sb.from('user_profiles').update({ must_change_password: false }).eq('id', user.id)

      await sb.from('events').insert({
        user_id: user.id, email: user.email, action: 'change_password', user_agent: 'self-service',
      })

      if (BREVO) {
        await sendBrevo(BREVO, user.email!, user.user_metadata?.nome || user.email!,
          'Sua senha do SimulaPro foi alterada',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:#0B3D91;padding:24px;border-radius:8px 8px 0 0">
              <h2 style="color:#fff;margin:0;font-size:18px">🏠 SimulaPro</h2>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 12px">Sua senha foi alterada agora há pouco. Se não foi você, entre em contato imediatamente.</p>
              <a href="${APP}/login.html" style="display:inline-block;background:#0B3D91;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Acessar o SimulaPro</a>
            </div>
          </div>`
        )
      }

      return json({ success: true })
    }

    // verificar se é admin
    const { data: adminRow } = await sb
      .from('admins')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!adminRow) return json({ error: 'Acesso negado' }, 403)

    // ── GET_ASAAS_ASSINATURAS ─────────────────────────────────
    if (action === 'get_asaas_assinaturas') {
      const { data, error: ae } = await sb.from('asaas_assinaturas').select('*').order('criado_em', { ascending: false })
      if (ae) return json({ error: ae.message }, 500)
      return json({ assinaturas: data ?? [] })
    }

    // ── FINANCEIRO MANUAL (fallback para corretores fora da Asaas) ──
    // Substitui o antigo localStorage do admin.html — agora persiste no
    // Postgres, atrás do mesmo gate de admin usado no resto deste arquivo.
    if (action === 'get_fin_data') {
      const [am, cfg] = await Promise.all([
        sb.from('assinaturas_manuais').select('*'),
        sb.from('app_config').select('*').eq('id', 1).maybeSingle(),
      ])
      if (am.error) return json({ error: am.error.message }, 500)
      const assinaturas: Record<string, unknown> = {}
      for (const row of am.data ?? []) {
        assinaturas[row.user_id] = {
          plano: row.plano, valor: row.valor, status: row.status,
          vencimento: row.vencimento, notas: row.notas, inicio: row.inicio,
        }
      }
      return json({
        assinaturas,
        planos: cfg.data?.planos ?? [{ id: 'mensal', nome: 'Mensal', preco: 70 }, { id: 'anual', nome: 'Anual', preco: 600 }],
        trial_dias: cfg.data?.trial_dias ?? 14,
        email_suporte: cfg.data?.email_suporte ?? 'simulador.wc@gmail.com',
      })
    }

    if (action === 'save_fin_assinatura') {
      const { userId, plano, valor, status, vencimento, notas, inicio } = payload
      if (!userId) return json({ error: 'userId obrigatorio' }, 400)
      const { error: fe } = await sb.from('assinaturas_manuais').upsert({
        user_id: userId,
        plano: plano ?? null,
        valor: typeof valor === 'number' ? valor : parseFloat(valor) || 0,
        status: status ?? null,
        vencimento: vencimento || null,
        notas: notas ?? '',
        inicio: inicio || null,
        updated_at: new Date().toISOString(),
      })
      if (fe) return json({ error: fe.message }, 500)
      await sb.from('audit_log').insert({ admin_user_id: user.id, admin_email: user.email, action: 'save_fin_assinatura', alvo: userId })
      return json({ success: true })
    }

    if (action === 'delete_fin_assinatura') {
      const { userId } = payload
      if (!userId) return json({ error: 'userId obrigatorio' }, 400)
      const { error: fe } = await sb.from('assinaturas_manuais').delete().eq('user_id', userId)
      if (fe) return json({ error: fe.message }, 500)
      return json({ success: true })
    }

    if (action === 'save_fin_planos') {
      const { planos } = payload
      if (!Array.isArray(planos)) return json({ error: 'planos deve ser um array' }, 400)
      const safePlanos = planos.slice(0, 20).map((p: any) => ({
        id: String(p.id ?? '').slice(0, 40),
        nome: String(p.nome ?? '').slice(0, 60),
        preco: typeof p.preco === 'number' ? p.preco : parseFloat(p.preco) || 0,
      }))
      const { error: fe } = await sb.from('app_config').update({ planos: safePlanos, updated_at: new Date().toISOString() }).eq('id', 1)
      if (fe) return json({ error: fe.message }, 500)
      await sb.from('audit_log').insert({ admin_user_id: user.id, admin_email: user.email, action: 'save_fin_planos', alvo: '-' })
      return json({ success: true })
    }

    if (action === 'save_fin_config') {
      const trial_dias = Math.min(90, Math.max(1, parseInt(payload.trial_dias) || 14))
      const email_suporte = String(payload.email_suporte ?? 'simulador.wc@gmail.com').slice(0, 200)
      const { error: fe } = await sb.from('app_config').update({
        trial_dias, email_suporte, updated_at: new Date().toISOString(),
      }).eq('id', 1)
      if (fe) return json({ error: fe.message }, 500)
      await sb.from('audit_log').insert({ admin_user_id: user.id, admin_email: user.email, action: 'save_fin_config', alvo: '-' })
      return json({ success: true })
    }

    // ── GET_ASAAS_ENV (diagnóstico) ────────────────────────────
    if (action === 'get_asaas_env') {
      return json({ env: Deno.env.get('ASAAS_ENV') ?? '(não definido — cai no default sandbox)' })
    }

    // ── REENVIAR_CREDENCIAIS ──────────────────────────────────
    // Gera senha nova e reenvia por email — usado quando o email original
    // deu bounce (typo, caixa cheia, etc) e o corretor já confirmou o
    // endereço certo.
    if (action === 'reenviar_credenciais') {
      const { userId } = payload
      if (!userId) return json({ error: 'userId obrigatorio' }, 400)
      const { data: perfil } = await sb.from('user_profiles').select('email, nome').eq('id', userId).maybeSingle()
      if (!perfil) return json({ error: 'Usuário não encontrado' }, 404)

      const senha = gerarSenha()
      const { error: pe } = await sb.auth.admin.updateUserById(userId, { password: senha })
      if (pe) return json({ error: pe.message }, 400)

      await sb.from('audit_log').insert({
        admin_user_id: user.id, admin_email: user.email, action: 'reenviar_credenciais', alvo: perfil.email,
      })

      let emailEnviado = false
      if (BREVO) {
        emailEnviado = await sendBrevo(BREVO, perfil.email, perfil.nome,
          'Seu acesso ao SimulaPro está liberado!',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
              <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${perfil.nome}!</p>
              <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu acesso ao SimulaPro está liberado. Use as credenciais abaixo para entrar.</p>
              <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 20px;font-family:monospace">
                <p style="margin:4px 0;font-size:14px"><strong>E-mail:</strong> ${perfil.email}</p>
                <p style="margin:4px 0;font-size:14px"><strong>Senha:</strong> ${senha}</p>
              </div>
              <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
            </div>
          </div>`
        )
      }
      return json({ success: true, emailEnviado, senha, email: perfil.email })
    }

    // ── REPROCESSAR_ASSINATURA_ASAAS (temporário) ─────────────
    // Para assinaturas que ficaram "pendente" porque o webhook estava
    // interrompido no momento do pagamento (evento não reenviado pela
    // Asaas). Confere o pagamento real antes de liberar — não confia
    // só no que está salvo no nosso banco.
    if (action === 'reprocessar_assinatura_asaas') {
      const { assinaturaId } = payload
      const { data: assinatura } = await sb.from('asaas_assinaturas').select('*').eq('id', assinaturaId).maybeSingle()
      if (!assinatura) return json({ error: 'Assinatura não encontrada' }, 404)
      if (assinatura.user_id) return json({ error: 'Assinatura já tem usuário vinculado' }, 400)

      const pagamentos = await asaasFetch(`/payments?subscription=${assinatura.asaas_subscription_id}`)
      const pago = (pagamentos.data?.data ?? []).some((p: any) => p.status === 'CONFIRMED' || p.status === 'RECEIVED')
      if (!pago) return json({ error: 'Nenhum pagamento CONFIRMED/RECEIVED encontrado na Asaas para esta assinatura', payments: pagamentos.data }, 400)

      const subInfo = await asaasFetch(`/subscriptions/${assinatura.asaas_subscription_id}`)
      const proximoVenc = subInfo.ok ? (subInfo.data?.nextDueDate ?? null) : null

      const senha = gerarSenha()
      const { data: nu, error: ce } = await sb.auth.admin.createUser({
        email: assinatura.email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome: assinatura.nome, tipo: 'corretor', origem: 'asaas' },
      })
      if (ce) {
        if (/already been registered|already registered/i.test(ce.message ?? '')) {
          return json({ error: 'Este e-mail já tem uma conta no SimulaPro (não criada por essa assinatura). Não mesclo automaticamente — confirme com o cliente e vincule manualmente se for o caso.' }, 409)
        }
        return json({ error: ce.message }, 400)
      }

      await sb.from('user_profiles').insert({
        id: nu.user!.id, email: assinatura.email, nome: assinatura.nome, status: 'ativo', plano: assinatura.plano,
      })
      await sb.from('asaas_assinaturas').update({
        user_id: nu.user!.id, status: 'ativo', invoice_url: null,
        proximo_vencimento: proximoVenc, atualizado_em: new Date().toISOString(),
      }).eq('id', assinatura.id)
      await sb.from('termos_aceites').insert({
        user_id: nu.user!.id, email: assinatura.email, versao: TERMOS_VERSAO,
        aceito_em: assinatura.termos_aceito_em ?? new Date().toISOString(),
        ip: assinatura.termos_ip, user_agent: assinatura.termos_user_agent,
      })
      await sb.from('audit_log').insert({
        admin_user_id: user.id, admin_email: user.email, action: 'reprocessar_assinatura_asaas', alvo: assinatura.email,
      })

      let emailEnviado = false
      if (BREVO) {
        emailEnviado = await sendBrevo(BREVO, assinatura.email, assinatura.nome,
          'Seu acesso ao SimulaPro está liberado!',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
              <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${assinatura.nome}!</p>
              <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu pagamento foi confirmado e seu acesso ao SimulaPro já está liberado.</p>
              <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 20px;font-family:monospace">
                <p style="margin:4px 0;font-size:14px"><strong>E-mail:</strong> ${assinatura.email}</p>
                <p style="margin:4px 0;font-size:14px"><strong>Senha:</strong> ${senha}</p>
              </div>
              <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
            </div>
          </div>`
        )
      }

      return json({ success: true, userId: nu.user!.id, emailEnviado })
    }

    // ── REATIVAR_WEBHOOK_ASAAS (temporário) ───────────────────
    // A Asaas pausa (interrupted=true) um webhook automaticamente após
    // falhas consecutivas e não reativa sozinha — precisa reenviar a config.
    if (action === 'reativar_webhook_asaas') {
      const { webhookId } = payload
      const atual = await asaasFetch(`/webhooks/${webhookId}`)
      if (!atual.ok) return json({ error: 'Webhook não encontrado', detalhe: atual.data }, 404)
      const put = await asaasFetch(`/webhooks/${webhookId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: atual.data.name,
          url: atual.data.url,
          email: atual.data.email,
          enabled: true,
          interrupted: false,
          apiVersion: atual.data.apiVersion,
          authToken: Deno.env.get('ASAAS_WEBHOOK_TOKEN'),
          sendType: atual.data.sendType,
          events: atual.data.events,
        }),
      })
      return json({ antes: atual.data, resultado: put.data, ok: put.ok })
    }

    // ── DIAGNOSTICO_ASAAS (temporário) ────────────────────────
    // Investiga por que uma assinatura ficou "pendente" mesmo com pagamento
    // aparentemente confirmado: consulta o pagamento real na Asaas e a
    // configuração de webhooks cadastrada na conta.
    if (action === 'diagnostico_asaas') {
      const { assinaturaId } = payload
      const { data: a } = await sb.from('asaas_assinaturas').select('*').eq('id', assinaturaId).maybeSingle()
      if (!a) return json({ error: 'Assinatura não encontrada' }, 404)

      const [sub, pagamentos, webhooks] = await Promise.all([
        asaasFetch(`/subscriptions/${a.asaas_subscription_id}`),
        asaasFetch(`/payments?subscription=${a.asaas_subscription_id}`),
        asaasFetch(`/webhooks`),
      ])

      return json({
        env: Deno.env.get('ASAAS_ENV') ?? '(não definido)',
        assinatura: a,
        subscription: sub.data,
        payments: pagamentos.data,
        webhooksConfigurados: webhooks.data,
      })
    }

    // ── GET_STATS ─────────────────────────────────────────────
    if (action === 'get_stats') {
      const [r1, r2, r3] = await Promise.all([
        sb.from('user_profiles').select('*', { count: 'exact', head: true }),
        sb.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'ativo'),
        sb.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'bloqueado'),
      ])
      const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
      const r4 = await sb.from('events')
        .select('*', { count: 'exact', head: true })
        .eq('action', 'login')
        .gte('created_at', hoje.toISOString())
      const r5 = await sb.from('solicitacoes_teste')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pendente')
      return json({ total: r1.count, ativos: r2.count, bloqueados: r3.count, loginsHoje: r4.count, solicitacoesPendentes: r5.count })
    }

    // ── GET_USERS ─────────────────────────────────────────────
    if (action === 'get_users') {
      const { data: users } = await sb
        .from('user_profiles')
        .select('*')
        .order('data_criacao', { ascending: false })
      const ids = (users ?? []).map((u: any) => u.id)

      // logins + atividade recente + contagem de simulações
      const [{ data: logins }, { data: activities }, { data: sims }] = await Promise.all([
        sb.from('events')
          .select('user_id, created_at')
          .in('user_id', ids)
          .eq('action', 'login')
          .order('created_at', { ascending: false }),
        sb.from('events')
          .select('user_id, created_at')
          .in('user_id', ids)
          .order('created_at', { ascending: false }),
        sb.from('events')
          .select('user_id')
          .in('user_id', ids)
          .in('action', ['simulacao', 'simulacao_construtora']),
      ])

      const lastLogin: Record<string, string> = {}
      ;(logins ?? []).forEach((l: any) => {
        if (!lastLogin[l.user_id]) lastLogin[l.user_id] = l.created_at
      })
      const lastSeen: Record<string, string> = {}
      ;(activities ?? []).forEach((l: any) => {
        if (!lastSeen[l.user_id]) lastSeen[l.user_id] = l.created_at
      })
      const simCount: Record<string, number> = {}
      ;(sims ?? []).forEach((l: any) => {
        simCount[l.user_id] = (simCount[l.user_id] ?? 0) + 1
      })

      // user_metadata + last_sign_in_at nativo do Supabase (fonte mais confiável)
      const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 })
      const metaMap: Record<string, any> = {}
      const signInMap: Record<string, string> = {}
      ;(authUsers ?? []).forEach((u: any) => {
        metaMap[u.id] = u.user_metadata ?? {}
        if (u.last_sign_in_at) signInMap[u.id] = u.last_sign_in_at
      })

      const enriched = (users ?? []).map((u: any) => ({
        ...u,
        ultimo_login:  lastLogin[u.id]  ?? signInMap[u.id] ?? null,
        last_seen_at:  lastSeen[u.id]   ?? signInMap[u.id] ?? null,
        user_metadata: metaMap[u.id] ?? {},
        sim_count:     simCount[u.id]   ?? 0,
      }))
      return json({ users: enriched })
    }

    // ── GET_USER_HISTORY ──────────────────────────────────────
    if (action === 'get_user_history') {
      const { email, dataInicio, dataFim } = payload
      if (!email) return json({ error: 'email obrigatorio' }, 400)
      let q = sb
        .from('events')
        .select('id, action, created_at, user_agent, details')
        .eq('email', email)
        .order('created_at', { ascending: false })
      if (dataInicio) q = q.gte('created_at', `${dataInicio}T00:00:00`)
      if (dataFim)    q = q.lte('created_at', `${dataFim}T23:59:59`)
      q = q.limit(dataInicio || dataFim ? 500 : 50)
      const { data, error: he } = await q
      if (he) return json({ error: he.message }, 500)
      return json({ logs: data ?? [] })
    }

    // ── GET_USER_SIMS ─────────────────────────────────────────
    if (action === 'get_user_sims') {
      const { email } = payload
      if (!email) return json({ error: 'email obrigatorio' }, 400)
      const { data, error: se } = await sb
        .from('events')
        .select('id, action, created_at, user_agent, details')
        .eq('email', email)
        .in('action', ['simulacao', 'simulacao_construtora', 'amortizacao'])
        .order('created_at', { ascending: false })
        .limit(500)
      if (se) return json({ error: se.message }, 500)
      return json({ sims: data ?? [] })
    }

    // ── GET_REQUESTS ──────────────────────────────────────────
    if (action === 'get_requests') {
      const { data, error: ge } = await sb
        .from('solicitacoes_teste')
        .select('*')
        .order('criado_em', { ascending: false })
      if (ge) return json({ error: ge.message }, 500)
      return json({ requests: data ?? [] })
    }

    // ── CREATE_USER ───────────────────────────────────────────
    if (action === 'create_user') {
      const { email, nome, senha, tipo } = payload
      if (!email || !nome || !senha) return json({ error: 'email, nome e senha obrigatorios' }, 400)

      const { data: nu, error: ce } = await sb.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, tipo: tipo ?? 'corretor' },
      })
      if (ce) return json({ error: ce.message }, 400)

      await sb.from('user_profiles').insert({
        id: nu.user!.id,
        email,
        nome,
        status: 'ativo',
        criado_por: user.id,
      })
      await sb.from('audit_log').insert({
        admin_user_id: user.id,
        admin_email: user.email,
        action: 'admin_create_user',
        alvo: email,
      })

      if (BREVO) {
        await sendBrevo(BREVO, email, nome,
          'Seu acesso ao SimulaPro',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:#0B3D91;padding:24px;border-radius:8px 8px 0 0">
              <h2 style="color:#fff;margin:0;font-size:18px">🏠 SimulaPro</h2>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 12px">Olá, <strong>${nome}</strong>! Seu acesso foi criado.</p>
              <div style="background:#F4F6FA;border-radius:8px;padding:16px;margin:16px 0;font-family:monospace;font-size:14px">
                <p style="margin:4px 0"><strong>E-mail:</strong> ${email}</p>
                <p style="margin:4px 0"><strong>Senha:</strong> ${senha}</p>
              </div>
              <a href="${APP}/login.html" style="display:inline-block;background:#0B3D91;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Acessar o SimulaPro</a>
            </div>
          </div>`
        )
      }

      return json({ success: true, userId: nu.user!.id })
    }

    // ── APPROVE_REQUEST ───────────────────────────────────────
    if (action === 'approve_request') {
      const { requestId, nome, email, senha } = payload
      if (!requestId || !email || !nome || !senha) return json({ error: 'campos obrigatórios ausentes' }, 400)

      // criar usuário
      const validade = new Date(); validade.setDate(validade.getDate() + 15)
      const { data: nu, error: ce } = await sb.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
        user_metadata: { nome, tipo: 'teste', validade: validade.toISOString().slice(0, 10) },
      })
      if (ce) return json({ error: ce.message }, 400)

      await sb.from('user_profiles').insert({
        id: nu.user!.id,
        email,
        nome,
        status: 'ativo',
        criado_por: user.id,
      })

      // marcar solicitação como aprovada
      await sb.from('solicitacoes_teste').update({
        status: 'aprovado',
        user_id: nu.user!.id,
        aprovado_em: new Date().toISOString(),
      }).eq('id', requestId)

      await sb.from('audit_log').insert({
        admin_user_id: user.id,
        admin_email: user.email,
        action: 'admin_create_teste',
        alvo: email,
      })

      // enviar email para o corretor
      if (BREVO) {
        const validadeStr = validade.toLocaleDateString('pt-BR')
        await sendBrevo(BREVO, email, nome,
          'Seu acesso de teste ao SimulaPro está pronto!',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0B3D91,#1565C0);padding:28px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0 0 6px;font-size:20px">🏠 SimulaPro</h2>
              <p style="color:rgba(255,255,255,.7);margin:0;font-size:13px">Simulador de Financiamento Imobiliário</p>
            </div>
            <div style="background:#fff;border:1px solid #E8ECF4;padding:28px 24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0F172A">Olá, ${nome}!</p>
              <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6">Seu acesso de teste ao SimulaPro está ativo. Use as credenciais abaixo para entrar e explorar a plataforma.</p>
              <div style="background:#F4F6FA;border:1px solid #E8ECF4;border-radius:10px;padding:18px;margin:0 0 20px;font-family:monospace">
                <p style="margin:4px 0;font-size:14px"><strong>E-mail:</strong> ${email}</p>
                <p style="margin:4px 0;font-size:14px"><strong>Senha:</strong> ${senha}</p>
                <p style="margin:8px 0 0;font-size:12px;color:#64748B">⏱️ Acesso válido por <strong>15 dias</strong> — até ${validadeStr}</p>
              </div>
              <a href="${APP}/login.html" style="display:inline-block;width:100%;background:#0B3D91;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Acessar o SimulaPro →</a>
              <p style="margin:16px 0 0;font-size:12px;color:#94A3B8;text-align:center">Dúvidas? Responda este e-mail ou entre em contato pelo WhatsApp.</p>
            </div>
          </div>`
        )
      }

      return json({ success: true, userId: nu.user!.id })
    }

    // ── TOGGLE_USER ───────────────────────────────────────────
    if (action === 'toggle_user') {
      const { userId, block } = payload
      if (!userId) return json({ error: 'userId obrigatorio' }, 400)
      const { error: te } = await sb.auth.admin.updateUserById(userId, {
        ban_duration: block ? '87600h' : 'none',
      })
      if (te) return json({ error: te.message }, 400)
      await sb.from('user_profiles').update({ status: block ? 'bloqueado' : 'ativo' }).eq('id', userId)
      await sb.from('audit_log').insert({
        admin_user_id: user.id,
        admin_email: user.email,
        action: block ? 'admin_block' : 'admin_unblock',
        alvo: userId,
      })
      return json({ success: true })
    }

    // ── DELETE_USER ───────────────────────────────────────────
    if (action === 'delete_user') {
      const { userId } = payload
      if (!userId) return json({ error: 'userId obrigatorio' }, 400)
      const { error: de } = await sb.auth.admin.deleteUser(userId)
      if (de) return json({ error: de.message }, 400)
      await sb.from('audit_log').insert({
        admin_user_id: user.id,
        admin_email: user.email,
        action: 'admin_delete',
        alvo: userId,
      })
      return json({ success: true })
    }

    // ── CANCELAR_ASSINATURA_ASAAS (admin) ─────────────────────
    // Cancela na Asaas + marca como cancelado no nosso banco. Útil pra
    // limpar assinaturas de teste/duplicadas sem mexer direto no painel.
    if (action === 'cancelar_assinatura_asaas') {
      const { assinaturaId } = payload
      if (!assinaturaId) return json({ error: 'assinaturaId obrigatorio' }, 400)
      const { data: a } = await sb.from('asaas_assinaturas').select('*').eq('id', assinaturaId).maybeSingle()
      if (!a) return json({ error: 'Assinatura não encontrada' }, 404)
      if (a.asaas_subscription_id) {
        await asaasFetch(`/subscriptions/${a.asaas_subscription_id}`, { method: 'DELETE' })
      }
      await sb.from('asaas_assinaturas').update({ status: 'cancelado', atualizado_em: new Date().toISOString() }).eq('id', assinaturaId)
      await sb.from('audit_log').insert({ admin_user_id: user.id, admin_email: user.email, action: 'cancelar_assinatura_asaas', alvo: a.email })
      return json({ success: true })
    }

    return json({ error: 'Acao desconhecida' }, 400)

  } catch (e) {
    console.error('edge error:', e)
    return json({ error: 'Erro interno' }, 500)
  }
})
