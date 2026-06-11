exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, {
      ok: false,
      error: "Configuracao de banco de dados incompleta."
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Dados invalidos." });
  }

  const documento = onlyDigits(payload.documento);
  const acesso = cleanText(payload.acesso)?.toLowerCase() || "";

  if (!documento || ![11, 14].includes(documento.length)) {
    return json(400, { ok: false, error: "Informe CPF ou CNPJ com 11 ou 14 digitos." });
  }

  if (!acesso) {
    return json(400, { ok: false, error: "Informe e-mail ou WhatsApp cadastrado." });
  }

  try {
    const empresas = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `empresas?select=*&documento=eq.${encodeURIComponent(documento)}&limit=1`
    );
    const empresa = empresas[0];

    if (!empresa) {
      return json(404, {
        ok: false,
        error: "Cadastro nao encontrado. Confira os dados ou faca sua adesao."
      });
    }

    const acessoNormalizado = onlyDigits(acesso) || acesso;
    const emailConfere = empresa.email && empresa.email.toLowerCase() === acesso;
    const telefoneConfere = empresa.telefone && onlyDigits(empresa.telefone) === acessoNormalizado;

    if (!emailConfere && !telefoneConfere) {
      return json(401, {
        ok: false,
        error: "E-mail ou WhatsApp nao confere com o cadastro da empresa."
      });
    }

    if (empresa.status !== "ativo") {
      return json(403, {
        ok: false,
        status: empresa.status,
        error: "Sua assinatura ainda nao esta ativa. Verifique o pagamento ou fale com o suporte."
      });
    }

    return json(200, {
      ok: true,
      empresa: {
        id: empresa.id,
        nome: empresa.nome,
        responsavel: empresa.responsavel,
        email: empresa.email,
        telefone: empresa.telefone,
        documento: empresa.documento,
        status: empresa.status
      }
    });
  } catch (error) {
    console.error("Erro ao acessar area da loja", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Nao foi possivel acessar a loja agora."
    });
  }
};

async function supabaseRequest(supabaseUrl, serviceRoleKey, path) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  return response.json();
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function onlyDigits(value) {
  const text = String(value || "").replace(/\D/g, "");
  return text || null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
