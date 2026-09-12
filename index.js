import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from "resend";
import PDFDocument from "pdfkit";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  }),
);

app.use(express.json({ limit: "100kb" }));

const PORT = Number(process.env.PORT || 5000);

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// =========================================================
// BASIC HELPERS
// =========================================================

function money(n) {
  return `${Number(n || 0).toLocaleString("en-BD")}TK`;
}

function orderId() {
  return `TIE-${new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "")}-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;
}

function paymentName(method) {
  const names = {
    bkash: "bKash",
    nagad: "Nagad",
    rocket: "Rocket",
    cod: "Cash on Delivery",
  };

  return names[method] || method || "Cash on Delivery";
}

function deliveryName(amount) {
  return Number(amount) === 80 ? "Inside Dhaka" : "Outside Dhaka";
}

// =========================================================
// VALIDATION
// =========================================================

function validate(body) {
  const customer = body?.customer;
  const pricing = body?.pricing;
  const items = body?.items;

  if (!customer?.name || !customer?.phone || !customer?.address) {
    throw new Error("Customer information is incomplete.");
  }

  if (!Array.isArray(items) || !items.length) {
    throw new Error("No products selected.");
  }

  if (!pricing || !Number.isFinite(Number(pricing.total))) {
    throw new Error("Invalid order total.");
  }
}

// =========================================================
// WHATSAPP / TELEGRAM SUMMARY
// =========================================================

function summaryText(o) {
  const lines = o.items
    .map(
      (x) =>
        `• ${x.productName} | Size ${x.size} | ${x.qty} pcs | ${money(
          x.qty * o.pricing.unitPrice,
        )}`,
    )
    .join("\n");

  const transactionLine = o.payment?.transactionId
    ? `\nTransaction ID: ${o.payment.transactionId}`
    : "";

  const imageLine = o.payment?.imageUrl
    ? `\nPayment Screenshot: ${o.payment.imageUrl}`
    : "";

  return `🛍 TAKE IT EASY — NEW ORDER

Order ID: ${o.id}

Customer: ${o.customer.name}

Phone: ${o.customer.phone}

Address: ${o.customer.address}

Delivery: ${deliveryName(o.deliveryArea)} (${money(o.deliveryArea)})

PRODUCTS

${lines}

Subtotal: ${money(o.pricing.subtotal)}

Discount: -${money(o.pricing.discount)}

Delivery: ${money(o.pricing.delivery)}

TOTAL: ${money(o.pricing.total)}

Coupon: ${o.coupon || "None"}

Payment: ${paymentName(o.payment?.method)}${transactionLine}${imageLine}`;
}

// =========================================================
// EMAIL HTML
// =========================================================

function htmlEmail(o) {
  const rows = o.items
    .map(
      (x) => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #eee">
            ${x.productName}
          </td>

          <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">
            ${x.size}
          </td>

          <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">
            ${x.qty}
          </td>

          <td style="padding:10px;border-bottom:1px solid #eee;text-align:right">
            ${money(x.qty * o.pricing.unitPrice)}
          </td>
        </tr>
      `,
    )
    .join("");

  const transactionHtml = o.payment?.transactionId
    ? `<br><b>Transaction ID:</b> ${o.payment.transactionId}`
    : "";

  const imageHtml = o.payment?.imageUrl
    ? `<br><b>Payment Screenshot:</b> <a href="${o.payment.imageUrl}">${o.payment.imageUrl}</a>`
    : "";

  return `
<!doctype html>

<html>

<body
  style="
    margin:0;
    padding:24px;
    background:#f5f5f2;
    color:#111;
    font-family:Arial,sans-serif;
  "
>

<div
  style="
    max-width:700px;
    margin:auto;
    background:#fff;
    border-radius:20px;
    overflow:hidden;
    border:1px solid #e8e8e8;
  "
>

  <div
    style="
      background:#080808;
      color:#fff;
      padding:28px;
    "
  >

    <div
      style="
        color:#ff5a00;
        font-size:12px;
        font-weight:800;
        letter-spacing:2px;
      "
    >
      TAKE IT EASY
    </div>

    <h1 style="margin:10px 0 0;font-size:26px;">
      New Order
    </h1>

    <p style="margin:6px 0 0;color:#aaa;">
      ${o.id}
    </p>

  </div>


  <div style="padding:28px;">

    <h3>Customer Information</h3>

    <p style="line-height:1.8;">
      <b>${o.customer.name}</b><br>
      ${o.customer.phone}<br>
      ${o.customer.address}
    </p>


    <h3>Products</h3>

    <table
      style="
        width:100%;
        border-collapse:collapse;
        font-size:14px;
      "
    >

      <thead>

        <tr style="background:#f6f6f3;">

          <th style="padding:10px;text-align:left;">
            Product
          </th>

          <th style="padding:10px;">
            Size
          </th>

          <th style="padding:10px;">
            Qty
          </th>

          <th style="padding:10px;text-align:right;">
            Amount
          </th>

        </tr>

      </thead>

      <tbody>
        ${rows}
      </tbody>

    </table>


    <div
      style="
        margin-top:24px;
        padding:18px;
        background:#f7f7f5;
        border-radius:14px;
      "
    >

      <p>
        Subtotal:
        <b>${money(o.pricing.subtotal)}</b>
      </p>

      <p>
        Discount:
        <b>-${money(o.pricing.discount)}</b>
      </p>

      <p>
        Delivery:
        <b>${money(o.pricing.delivery)}</b>
      </p>

      <h2 style="color:#ff5a00;margin-bottom:0;">
        Total: ${money(o.pricing.total)}
      </h2>

    </div>


    <p style="line-height:1.8;">

      <b>Coupon:</b>
      ${o.coupon || "None"}

      <br>

      <b>Payment:</b>
      ${paymentName(o.payment?.method)}

      ${transactionHtml}

      ${imageHtml}

    </p>

  </div>

</div>

</body>

</html>
`;
}

// =========================================================
// PDF HELPERS
// =========================================================

function pdfText(doc, text, x, y, options = {}) {
  const {
    size = 10,
    color = "#111111",
    font = "Helvetica",
    width,
    align = "left",
    lineGap = 2,
  } = options;

  const config = {
    lineGap,
  };

  if (width !== undefined && width !== null) {
    config.width = width;
    config.align = align;
  }

  doc
    .font(font)
    .fontSize(size)
    .fillColor(color)
    .text(String(text ?? ""), x, y, config);
}

function drawLine(doc, x1, y1, x2, y2, color = "#e8e8e8") {
  doc
    .save()
    .strokeColor(color)
    .lineWidth(1)
    .moveTo(x1, y1)
    .lineTo(x2, y2)
    .stroke()
    .restore();
}

function drawBox(doc, x, y, width, height, options = {}) {
  const { fill = "#f7f7f5", stroke = "#e8e8e8", radius = 10 } = options;

  doc
    .save()
    .roundedRect(x, y, width, height, radius)
    .fillAndStroke(fill, stroke)
    .restore();
}

// =========================================================
// MAKE PDF
// English PDF
// No Bengali Font Required
// =========================================================

async function makePdf(o) {
  const file = path.join(os.tmpdir(), `${o.id}.pdf`);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: true,
    });

    const out = fsSync.createWriteStream(file);

    doc.pipe(out);

    const pageWidth = 595.28;
    const pageHeight = 841.89;

    const margin = 42;
    const contentWidth = pageWidth - margin * 2;

    // =====================================================
    // HEADER
    // =====================================================

    doc.save().rect(0, 0, pageWidth, 118).fill("#080808").restore();

    pdfText(doc, "TAKE IT EASY", margin, 28, {
      size: 22,
      color: "#ffffff",
      font: "Helvetica-Bold",
    });

    pdfText(doc, "WEAR IT EASY", margin, 57, {
      size: 9,
      color: "#ff5a00",
      font: "Helvetica-Bold",
    });

    pdfText(doc, "ORDER SUMMARY", margin, 78, {
      size: 11,
      color: "#dddddd",
      font: "Helvetica",
    });

    pdfText(doc, o.id, pageWidth - margin - 190, 38, {
      size: 10,
      color: "#ffffff",
      font: "Helvetica",
      width: 190,
      align: "right",
    });

    const createdDate = new Date(o.createdAt);

    pdfText(
      doc,
      createdDate.toLocaleDateString("en-GB"),
      pageWidth - margin - 190,
      61,
      {
        size: 9,
        color: "#aaaaaa",
        font: "Helvetica",
        width: 190,
        align: "right",
      },
    );

    let y = 145;

    // =====================================================
    // CUSTOMER INFORMATION
    // =====================================================

    pdfText(doc, "CUSTOMER INFORMATION", margin, y, {
      size: 14,
      color: "#111111",
      font: "Helvetica-Bold",
    });

    y += 27;

    const customerBoxHeight = 112;

    drawBox(doc, margin, y, contentWidth, customerBoxHeight, {
      fill: "#f7f7f5",
      stroke: "#e5e5e5",
      radius: 10,
    });

    // Name

    pdfText(doc, "NAME", margin + 16, y + 14, {
      size: 8,
      color: "#777777",
      font: "Helvetica",
    });

    pdfText(doc, o.customer.name, margin + 16, y + 31, {
      size: 11,
      color: "#111111",
      font: "Helvetica-Bold",
      width: 210,
    });

    // Phone

    pdfText(doc, "PHONE", margin + 245, y + 14, {
      size: 8,
      color: "#777777",
      font: "Helvetica",
    });

    pdfText(doc, o.customer.phone, margin + 245, y + 31, {
      size: 11,
      color: "#111111",
      font: "Helvetica-Bold",
      width: 190,
    });

    // Address

    pdfText(doc, "DELIVERY ADDRESS", margin + 16, y + 61, {
      size: 8,
      color: "#777777",
      font: "Helvetica",
    });

    pdfText(doc, o.customer.address, margin + 16, y + 78, {
      size: 9,
      color: "#111111",
      font: "Helvetica",
      width: contentWidth - 32,
    });

    y += customerBoxHeight + 22;

    // =====================================================
    // DELIVERY + PAYMENT
    // =====================================================

    const halfWidth = (contentWidth - 12) / 2;

    const infoHeight = 82;

    drawBox(doc, margin, y, halfWidth, infoHeight, {
      fill: "#fff8f3",
      stroke: "#ffe1cf",
      radius: 10,
    });

    drawBox(doc, margin + halfWidth + 12, y, halfWidth, infoHeight, {
      fill: "#f7f7f5",
      stroke: "#e5e5e5",
      radius: 10,
    });

    // Delivery

    pdfText(doc, "DELIVERY", margin + 16, y + 13, {
      size: 8,
      color: "#777777",
      font: "Helvetica",
    });

    pdfText(doc, deliveryName(o.deliveryArea), margin + 16, y + 31, {
      size: 10,
      color: "#111111",
      font: "Helvetica-Bold",
      width: halfWidth - 30,
    });

    pdfText(doc, money(o.pricing.delivery), margin + 16, y + 52, {
      size: 10,
      color: "#ff5a00",
      font: "Helvetica-Bold",
    });

    // Payment

    const paymentX = margin + halfWidth + 28;

    pdfText(doc, "PAYMENT", paymentX, y + 13, {
      size: 8,
      color: "#777777",
      font: "Helvetica",
    });

    pdfText(doc, paymentName(o.payment?.method), paymentX, y + 31, {
      size: 10,
      color: "#111111",
      font: "Helvetica-Bold",
      width: halfWidth - 35,
    });

    if (o.payment?.transactionId) {
      pdfText(
        doc,
        `Transaction ID: ${o.payment.transactionId}`,
        paymentX,
        y + 52,
        {
          size: 8,
          color: "#666666",
          font: "Helvetica",
          width: halfWidth - 35,
        },
      );
    }

    y += infoHeight + 25;

    // =====================================================
    // PRODUCTS
    // =====================================================

    pdfText(doc, "ORDER ITEMS", margin, y, {
      size: 14,
      color: "#111111",
      font: "Helvetica-Bold",
    });

    y += 25;

    const colProduct = 235;
    const colSize = 55;
    const colQty = 55;

    const colAmount = contentWidth - colProduct - colSize - colQty;

    // Table Header

    doc
      .save()
      .roundedRect(margin, y, contentWidth, 32, 8)
      .fill("#080808")
      .restore();

    pdfText(doc, "PRODUCT", margin + 12, y + 9, {
      size: 8,
      color: "#ffffff",
      font: "Helvetica-Bold",
      width: colProduct - 20,
    });

    pdfText(doc, "SIZE", margin + colProduct, y + 9, {
      size: 8,
      color: "#ffffff",
      font: "Helvetica-Bold",
      width: colSize,
      align: "center",
    });

    pdfText(doc, "QTY", margin + colProduct + colSize, y + 9, {
      size: 8,
      color: "#ffffff",
      font: "Helvetica-Bold",
      width: colQty,
      align: "center",
    });

    pdfText(doc, "AMOUNT", margin + colProduct + colSize + colQty, y + 9, {
      size: 8,
      color: "#ffffff",
      font: "Helvetica-Bold",
      width: colAmount,
      align: "right",
    });

    y += 32;

    // Product Rows

    o.items.forEach((item, index) => {
      const rowHeight = 46;

      if (index % 2 === 0) {
        doc
          .save()
          .rect(margin, y, contentWidth, rowHeight)
          .fill("#fafafa")
          .restore();
      }

      drawLine(
        doc,
        margin,
        y + rowHeight,
        margin + contentWidth,
        y + rowHeight,
      );

      pdfText(doc, item.productName, margin + 12, y + 10, {
        size: 8,
        color: "#111111",
        font: "Helvetica",
        width: colProduct - 20,
      });

      pdfText(doc, item.size, margin + colProduct, y + 14, {
        size: 8,
        color: "#111111",
        font: "Helvetica-Bold",
        width: colSize,
        align: "center",
      });

      pdfText(doc, String(item.qty), margin + colProduct + colSize, y + 14, {
        size: 8,
        color: "#111111",
        font: "Helvetica-Bold",
        width: colQty,
        align: "center",
      });

      pdfText(
        doc,
        money(item.qty * o.pricing.unitPrice),
        margin + colProduct + colSize + colQty,
        y + 14,
        {
          size: 8,
          color: "#111111",
          font: "Helvetica-Bold",
          width: colAmount - 12,
          align: "right",
        },
      );

      y += rowHeight;
    });

    y += 20;

    // =====================================================
    // ORDER SUMMARY
    // =====================================================

    const summaryWidth = 245;
    const summaryHeight = 165;

    const summaryX = pageWidth - margin - summaryWidth;

    drawBox(doc, summaryX, y, summaryWidth, summaryHeight, {
      fill: "#f7f7f5",
      stroke: "#e5e5e5",
      radius: 10,
    });

    pdfText(doc, "ORDER TOTAL", summaryX + 16, y + 14, {
      size: 12,
      color: "#111111",
      font: "Helvetica-Bold",
    });

    // Subtotal

    pdfText(doc, "Subtotal", summaryX + 16, y + 45, {
      size: 8,
      color: "#666666",
      font: "Helvetica",
    });

    pdfText(doc, money(o.pricing.subtotal), summaryX + 16, y + 45, {
      size: 8,
      color: "#111111",
      font: "Helvetica",
      width: summaryWidth - 32,
      align: "right",
    });

    // Discount

    pdfText(doc, "Discount", summaryX + 16, y + 67, {
      size: 8,
      color: "#666666",
      font: "Helvetica",
    });

    pdfText(doc, `-${money(o.pricing.discount)}`, summaryX + 16, y + 67, {
      size: 8,
      color: "#159447",
      font: "Helvetica",
      width: summaryWidth - 32,
      align: "right",
    });

    // Delivery

    pdfText(doc, "Delivery Charge", summaryX + 16, y + 89, {
      size: 8,
      color: "#666666",
      font: "Helvetica",
    });

    pdfText(doc, money(o.pricing.delivery), summaryX + 16, y + 89, {
      size: 8,
      color: "#111111",
      font: "Helvetica",
      width: summaryWidth - 32,
      align: "right",
    });

    drawLine(
      doc,
      summaryX + 16,
      y + 112,
      summaryX + summaryWidth - 16,
      y + 112,
    );

    // Total

    pdfText(doc, "TOTAL", summaryX + 16, y + 127, {
      size: 10,
      color: "#111111",
      font: "Helvetica-Bold",
    });

    pdfText(doc, money(o.pricing.total), summaryX + 16, y + 124, {
      size: 14,
      color: "#ff5a00",
      font: "Helvetica-Bold",
      width: summaryWidth - 32,
      align: "right",
    });

    y += summaryHeight + 18;

    // =====================================================
    // COUPON
    // =====================================================

    if (o.coupon) {
      drawBox(doc, margin, y, contentWidth, 45, {
        fill: "#fff8f3",
        stroke: "#ffe1cf",
        radius: 10,
      });

      pdfText(doc, "COUPON", margin + 15, y + 8, {
        size: 8,
        color: "#777777",
        font: "Helvetica",
      });

      pdfText(doc, o.coupon, margin + 15, y + 22, {
        size: 9,
        color: "#ff5a00",
        font: "Helvetica-Bold",
      });

      pdfText(doc, "Coupon successfully applied", margin + 150, y + 15, {
        size: 8,
        color: "#159447",
        font: "Helvetica",
        width: contentWidth - 165,
        align: "right",
      });
    }

    // =====================================================
    // FOOTER
    // =====================================================

    const footerY = pageHeight - 65;

    drawLine(doc, margin, footerY - 12, pageWidth - margin, footerY - 12);

    pdfText(doc, "TAKE IT EASY • WEAR IT EASY", margin, footerY, {
      size: 7,
      color: "#888888",
      font: "Helvetica-Bold",
    });

    pdfText(
      doc,
      "Thank you for your order",
      pageWidth - margin - 210,
      footerY,
      {
        size: 7,
        color: "#888888",
        font: "Helvetica",
        width: 210,
        align: "right",
      },
    );

    doc.end();

    out.on("finish", resolve);
    out.on("error", reject);
  });

  return file;
}

// =========================================================
// EMAIL
// =========================================================

async function sendEmail(o, pdf) {
  if (!resend || !process.env.EMAIL_FROM || !process.env.ORDER_EMAIL_TO) {
    throw new Error("Email is not configured.");
  }

  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,

    to: [process.env.ORDER_EMAIL_TO],

    subject: `New Take It Easy Order — ${o.id} — ${money(o.pricing.total)}`,

    html: htmlEmail(o),

    attachments: [
      {
        filename: `${o.id}-order-summary.pdf`,
        content: await fs.readFile(pdf),
      },
    ],
  });

  if (error) {
    throw new Error(error.message || "Email sending failed.");
  }
}

// =========================================================
// WHATSAPP GRAPH API
// =========================================================

async function graph(pathname, body, headers = {}) {
  const version = process.env.WHATSAPP_API_VERSION || "v23.0";

  const url = `https://graph.facebook.com/${version}${pathname}`;

  const isMultipart =
    typeof FormData !== "undefined" && body instanceof FormData;

  const requestHeaders = {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    ...headers,
  };

  if (isMultipart) {
    delete requestHeaders["Content-Type"];
  } else {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: "POST",

    headers: requestHeaders,

    body: isMultipart ? body : JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "WhatsApp API error");
  }

  return data;
}

// =========================================================
// WHATSAPP
// =========================================================

async function sendWhatsApp(o, pdf) {
  if (
    !process.env.WHATSAPP_ACCESS_TOKEN ||
    !process.env.WHATSAPP_PHONE_NUMBER_ID ||
    !process.env.WHATSAPP_TO
  ) {
    throw new Error("WhatsApp is not configured.");
  }

  const to = process.env.WHATSAPP_TO.replace(/\D/g, "");

  const template = process.env.WHATSAPP_TEMPLATE_NAME?.trim();

  if (template) {
    await graph(`/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",

      to,

      type: "template",

      template: {
        name: template,

        language: {
          code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US",
        },

        components: [
          {
            type: "body",

            parameters: [
              {
                type: "text",

                text: summaryText(o).slice(0, 900),
              },
            ],
          },
        ],
      },
    });
  } else {
    await graph(`/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",

      to,

      type: "text",

      text: {
        preview_url: false,

        body: summaryText(o),
      },
    });
  }

  // =====================================================
  // OPTIONAL WHATSAPP PDF
  // =====================================================

  if (String(process.env.WHATSAPP_SEND_PDF).toLowerCase() === "true") {
    const fd = new FormData();

    fd.append("messaging_product", "whatsapp");

    fd.append("type", "application/pdf");

    fd.append(
      "file",
      new Blob([await fs.readFile(pdf)], {
        type: "application/pdf",
      }),
      `${o.id}.pdf`,
    );

    const media = await graph(
      `/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
      fd,
    );

    await graph(`/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",

      to,

      type: "document",

      document: {
        id: media.id,

        caption: `Order summary ${o.id}`,

        filename: `${o.id}.pdf`,
      },
    });
  }
}

// =========================================================
// TELEGRAM
// =========================================================

async function sendTelegram(o, pdf) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram is not configured.");
  }

  const api = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

  const text = summaryText(o);

  const msg = await fetch(`${api}/sendMessage`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,

      text,
    }),
  });

  const msgData = await msg.json();

  if (!msg.ok || !msgData.ok) {
    throw new Error(msgData?.description || "Telegram message sending failed.");
  }

  // =====================================================
  // OPTIONAL TELEGRAM PDF
  // =====================================================

  if (String(process.env.TELEGRAM_SEND_PDF).toLowerCase() === "true") {
    const fd = new FormData();

    fd.append("chat_id", process.env.TELEGRAM_CHAT_ID);

    fd.append("caption", `Order Summary ${o.id}`);

    fd.append(
      "document",
      new Blob([await fs.readFile(pdf)], {
        type: "application/pdf",
      }),
      `${o.id}-order-summary.pdf`,
    );

    const doc = await fetch(`${api}/sendDocument`, {
      method: "POST",
      body: fd,
    });

    const docData = await doc.json();

    if (!doc.ok || !docData.ok) {
      throw new Error(docData?.description || "Telegram PDF sending failed.");
    }
  }
}

// =========================================================
// HEALTH CHECK
// =========================================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Take It Easy API",
  });
});

// =========================================================
// ORDER API
// =========================================================

app.post("/api/orders", async (req, res) => {
  let pdf = null;

  try {
    // =================================================
    // VALIDATE ORDER
    // =================================================

    validate(req.body);

    // =================================================
    // CREATE ORDER
    // =================================================

    const o = {
      ...req.body,

      id: orderId(),

      createdAt: new Date().toISOString(),
    };

    console.log("NEW ORDER:", o.id);

    // =================================================
    // CREATE PDF
    // =================================================

    pdf = await makePdf(o);

    console.log("PDF CREATED:", pdf);

    // =================================================
    // SEND NOTIFICATIONS
    // =================================================

    const results = await Promise.allSettled([
      sendEmail(o, pdf),

      sendWhatsApp(o, pdf),

      sendTelegram(o, pdf),
    ]);

    const email = results[0].status === "fulfilled";

    const whatsapp = results[1].status === "fulfilled";

    const telegram = results[2].status === "fulfilled";

    // =================================================
    // LOG NOTIFICATION ERRORS
    // =================================================

    if (!email) {
      console.error(
        "EMAIL ERROR:",
        results[0].reason?.message || results[0].reason,
      );
    }

    if (!whatsapp) {
      console.error(
        "WHATSAPP ERROR:",
        results[1].reason?.message || results[1].reason,
      );
    }

    if (!telegram) {
      console.error(
        "TELEGRAM ERROR:",
        results[2].reason?.message || results[2].reason,
      );
    }

    // =================================================
    // IMPORTANT
    // ORDER IS SUCCESSFUL IF PDF WAS CREATED
    // =================================================

    res.json({
      ok: true,

      orderId: o.id,

      notifications: {
        email,
        whatsapp,
        telegram,
      },

      message: "Order received successfully.",
    });
  } catch (error) {
    console.error("ORDER ERROR:", error);

    res.status(500).json({
      ok: false,

      message: error?.message || "Order failed.",
    });
  } finally {
    // =================================================
    // DELETE TEMPORARY PDF
    // =================================================

    if (pdf) {
      fs.unlink(pdf).catch(() => {});
    }
  }
});

// =========================================================
// SERVER
// =========================================================

app.listen(PORT, () => {
  console.log(`Take It Easy API running on http://localhost:${PORT}`);
});
