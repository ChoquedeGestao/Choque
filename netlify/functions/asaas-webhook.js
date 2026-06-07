const allowedEvents = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_DELETED"
]);

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      service: "asaas-webhook",
      environment: process.env.ASAAS_ENVIRONMENT || "sandbox"
    });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expectedToken) {
    return json(500, { ok: false, error: "ASAAS_WEBHOOK_TOKEN nao configurado." });
  }

  const receivedToken = event.headers["asaas-access-token"] || event.headers["Asaas-Access-Token"];
  if (receivedToken !== expectedToken) {
    return json(401, { ok: false, error: "Token do webhook invalido." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "JSON invalido." });
  }

  const eventName = payload.event || "";
  if (!allowedEvents.has(eventName)) {
    return json(200, {
      ok: true,
      ignored: true,
      event: eventName || "EVENTO_NAO_INFORMADO"
    });
  }

  console.log("Asaas webhook recebido", {
    event: eventName,
    paymentId: payload.payment?.id,
    subscriptionId: payload.subscription?.id || payload.payment?.subscription,
    customerId: payload.customer?.id || payload.payment?.customer
  });

  return json(200, {
    ok: true,
    event: eventName
  });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
}
