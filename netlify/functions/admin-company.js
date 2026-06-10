exports.handler = async (event) => {
  if (!["POST", "PATCH"].includes(event.httpMethod)) {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const adminToken = process.env.ADMIN_PANEL_TOKEN;
  if (!adminToken) {
    return json(500, {
      ok: false,
      error: "ADMIN_PANEL_TOKEN nao configurado no Netlify."
    });
  }

  const receivedToken = getBearerToken(event.headers.authorization || event.headers.Authorization);
  if (receivedToken !== adminToken) {
    return json(401, {
      ok: false,
      error: "Senha administrativa invalida."
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, {
      ok: false,
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nao configurado."
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "JSON invalido." });
  }

  const company = normalizeCompany(payload);
  if (!company.nome) {
    return json(400, { ok: false, error: "Informe o nome da empresa." });
  }

  if (company.documento && !isValidDocument(company.documento)) {
    return json(400, { ok: false, error: "Informe um CPF ou CNPJ valido." });
  }

  try {
    if (event.httpMethod === "PATCH") {
      const companyId = cleanText(payload.id);
      if (!companyId) {
        return json(400, { ok: false, error: "Empresa nao informada." });
      }

      const updated = await supabaseRequest(
        supabaseUrl,
        serviceRoleKey,
        `empresas?id=eq.${encodeURIComponent(companyId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(company)
        }
      );

      return json(200, {
        ok: true,
        empresa: updated[0] || null
      });
    }

    const inserted = await supabaseRequest(supabaseUrl, serviceRoleKey, "empresas", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([company])
    });

    return json(201, {
      ok: true,
      empresa: inserted[0] || null
    });
  } catch (error) {
    console.error("Erro ao cadastrar empresa", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Erro ao cadastrar empresa no banco de dados."
    });
  }
};

function normalizeCompany(payload) {
  return {
    nome: cleanText(payload.nome),
    responsavel: cleanText(payload.responsavel),
    email: cleanText(payload.email),
    telefone: onlyDigits(payload.telefone),
    documento: onlyDigits(payload.documento),
    status: normalizeStatus(payload.status),
    updated_at: new Date().toISOString()
  };
}

async function supabaseRequest(supabaseUrl, serviceRoleKey, path, options = {}) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    body: options.body
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return [];
  }

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function getBearerToken(header) {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function onlyDigits(value) {
  const text = String(value || "").replace(/\D/g, "");
  return text || null;
}

function normalizeStatus(value) {
  const allowed = new Set(["pendente", "ativo", "inadimplente", "cancelado"]);
  return allowed.has(value) ? value : "pendente";
}

function isValidDocument(value) {
  if (value.length === 11) return isValidCpf(value);
  if (value.length === 14) return isValidCnpj(value);
  return false;
}

function isValidCpf(cpf) {
  if (/^(\d)\1+$/.test(cpf)) return false;

  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += Number(cpf[index]) * (10 - index);
  }
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;

  sum = 0;
  for (let index = 0; index < 10; index += 1) {
    sum += Number(cpf[index]) * (11 - index);
  }
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;

  return digit === Number(cpf[10]);
}

function isValidCnpj(cnpj) {
  if (/^(\d)\1+$/.test(cnpj)) return false;

  const validateDigit = (length) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    const sum = weights.reduce((total, weight, index) => {
      return total + Number(cnpj[index]) * weight;
    }, 0);
    const remainder = sum % 11;
    const digit = remainder < 2 ? 0 : 11 - remainder;

    return digit === Number(cnpj[length]);
  };

  return validateDigit(12) && validateDigit(13);
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

