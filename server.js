require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// 🔑 Stripe initialization
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 🌍 Allowed origins (FRONTEND + LOCAL DEV)
const allowedOrigins = [
  "https://creo-4-real.netlify.app",
  "https://creo4real.com",
  "https://www.creo4real.com",
  "http://localhost:5173"
];

const CRYPTO_TOKEN_SYMBOL = process.env.CRYPTO_TOKEN_SYMBOL || "USDT";
const CRYPTO_TOKEN_DECIMALS = Number(process.env.CRYPTO_TOKEN_DECIMALS || 6);
const CRYPTO_TOKEN_CONTRACT = process.env.CRYPTO_TOKEN_CONTRACT || "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"; // USDT on TRON
const TRONGRID_API_URL = process.env.TRONGRID_API_URL || "https://api.trongrid.io";

const CRYPTO_PAYMENT_EXPIRY_MINUTES = Number(process.env.CRYPTO_PAYMENT_EXPIRY_MINUTES || 30);
const CRYPTO_USDT_PER_DONATION_UNIT = Number(process.env.CRYPTO_USDT_PER_DONATION_UNIT || 1);
const CRYPTO_AMOUNT_TOLERANCE = Number(process.env.CRYPTO_AMOUNT_TOLERANCE || 0.000001);
const cryptoPayments = new Map();

const cryptoTokenDecimals = () => Math.pow(10, CRYPTO_TOKEN_DECIMALS);

const createPaymentId = () => {
  if (global.crypto?.randomUUID) return global.crypto.randomUUID();
  return `crypto_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const createUniqueExpectedAmount = (donationAmount) => {
  const baseTokenAmount = Math.max(Number(donationAmount) * CRYPTO_USDT_PER_DONATION_UNIT, 0);
  // Tiny unique amount for automatic matching while still letting the donor choose the donation amount.
  // Example: donor chooses 25, exact blockchain amount might be 25.004317 USDT.
  const uniqueSuffix = Math.floor(1 + Math.random() * 9998) / 1000000; // 0.000001 to 0.009998 USDT
  return Number((baseTokenAmount + uniqueSuffix).toFixed(CRYPTO_TOKEN_DECIMALS));
};

const publicCryptoPayment = (payment) => ({
  paymentId: payment.paymentId,
  status: payment.status,
  message: payment.message,
  depositAddress: payment.depositAddress,
  network: payment.network,
  token: CRYPTO_TOKEN_SYMBOL,
  expectedTokenAmount: payment.expectedTokenAmount.toFixed(CRYPTO_TOKEN_DECIMALS).replace(/\.?0+$/, ""),
  donationAmount: payment.donationAmount,
  expiresAt: new Date(payment.expiresAt).toISOString(),
  transactionUrl: payment.transactionHash ? `https://tronscan.org/#/transaction/${payment.transactionHash}` : undefined,
  amountReceived: payment.amountReceived ? payment.amountReceived.toFixed(CRYPTO_TOKEN_DECIMALS).replace(/\.?0+$/, "") : undefined,
});

const normalizeTxHash = (txHash) => String(txHash || "").trim().replace(/^0x/i, "");

const fetchTronGrid = async (path) => {
  const headers = {};
  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  }

  const response = await fetch(`${TRONGRID_API_URL}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`TRON API error: ${response.status}`);
  }
  return response.json();
};

const findMatchingTransferEvent = async ({ txHash, depositAddress }) => {
  const data = await fetchTronGrid(`/v1/transactions/${txHash}/events`);
  const events = Array.isArray(data?.data) ? data.data : [];

  return events.find((event) => {
    const eventName = String(event?.event_name || event?.eventName || "").toLowerCase();
    const contractAddress = String(event?.contract_address || event?.contractAddress || "");
    const toAddress = String(event?.result?.to || event?.result?._to || event?.result?.recipient || "");

    const isTransfer = eventName === "transfer";
    const matchesContract = !CRYPTO_TOKEN_CONTRACT || contractAddress === CRYPTO_TOKEN_CONTRACT;
    const matchesReceiver = toAddress === depositAddress;

    return isTransfer && matchesContract && matchesReceiver;
  });
};

const getTransferAmount = (event) => {
  const rawValue = event?.result?.value || event?.result?._value || event?.result?.amount || "0";
  const amount = Number(rawValue) / Math.pow(10, CRYPTO_TOKEN_DECIMALS);
  return Number.isFinite(amount) ? amount : 0;
};


const fetchIncomingTrc20Transfers = async ({ depositAddress, minTimestamp }) => {
  const params = new URLSearchParams({
    only_confirmed: "true",
    limit: "200",
    order_by: "block_timestamp,desc",
    min_timestamp: String(minTimestamp),
  });

  if (CRYPTO_TOKEN_CONTRACT) {
    params.set("contract_address", CRYPTO_TOKEN_CONTRACT);
  }

  const data = await fetchTronGrid(`/v1/accounts/${depositAddress}/transactions/trc20?${params.toString()}`);
  return Array.isArray(data?.data) ? data.data : [];
};

const transferAmountFromAccountEvent = (transfer) => {
  const decimals = Number(transfer?.token_info?.decimals ?? CRYPTO_TOKEN_DECIMALS);
  const rawValue = transfer?.value || "0";
  const amount = Number(rawValue) / Math.pow(10, decimals);
  return Number.isFinite(amount) ? amount : 0;
};

const findAutomaticPaymentMatch = async (payment) => {
  const transfers = await fetchIncomingTrc20Transfers({
    depositAddress: payment.depositAddress,
    minTimestamp: payment.createdAt,
  });

  return transfers.find((transfer) => {
    const to = String(transfer?.to || "");
    const contract = String(transfer?.token_info?.address || transfer?.contract_address || "");
    const amount = transferAmountFromAccountEvent(transfer);

    const receiverMatches = to === payment.depositAddress;
    const contractMatches = !CRYPTO_TOKEN_CONTRACT || contract === CRYPTO_TOKEN_CONTRACT;
    const amountMatches = Math.abs(amount - payment.expectedTokenAmount) <= CRYPTO_AMOUNT_TOLERANCE;

    return receiverMatches && contractMatches && amountMatches;
  });
};

const updateAutomaticCryptoPaymentStatus = async (payment) => {
  if (["confirmed", "expired", "failed"].includes(payment.status)) return payment;

  if (Date.now() > payment.expiresAt) {
    payment.status = "expired";
    payment.message = "This crypto payment request expired. Please generate a new payment amount and send the new exact amount.";
    cryptoPayments.set(payment.paymentId, payment);
    return payment;
  }

  const match = await findAutomaticPaymentMatch(payment);

  if (match) {
    payment.status = "confirmed";
    payment.transactionHash = match.transaction_id || match.transactionId || match.txID;
    payment.amountReceived = transferAmountFromAccountEvent(match);
    payment.message = "Payment confirmed automatically on the TRON blockchain.";
    cryptoPayments.set(payment.paymentId, payment);
    return payment;
  }

  payment.status = "waiting";
  payment.message = "Waiting for the exact TRC20 transfer to arrive. This page checks the blockchain automatically.";
  cryptoPayments.set(payment.paymentId, payment);
  return payment;
};



const DATA_DIR = path.join(__dirname, "data");
const VIDEO_FILE = path.join(DATA_DIR, "video-of-the-day.json");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-this-password";
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "change-this-secret";
const ADMIN_TOKEN = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_TOKEN_SECRET}`).toString("base64url");

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "";
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "";
const CLOUDINARY_UPLOAD_FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER || "creo4real/video-of-the-day";

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const emptyVideoOfTheDay = () => ({
  title: "",
  description: "",
  videoUrl: "",
  embedUrl: "",
  updatedAt: null,
});

const readLocalVideoOfTheDay = () => {
  ensureDataDir();
  if (!fs.existsSync(VIDEO_FILE)) return emptyVideoOfTheDay();

  try {
    return JSON.parse(fs.readFileSync(VIDEO_FILE, "utf8"));
  } catch {
    return emptyVideoOfTheDay();
  }
};

const saveVideoOfTheDay = (video) => {
  ensureDataDir();
  fs.writeFileSync(VIDEO_FILE, JSON.stringify(video, null, 2));
};

const fetchLatestCloudinaryVideo = async () => {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return emptyVideoOfTheDay();
  }

  try {
    const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64");
    const expression = `resource_type:video AND folder:${CLOUDINARY_UPLOAD_FOLDER}`;

    const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/search`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expression,
        sort_by: [{ created_at: "desc" }],
        max_results: 1,
      }),
    });

    if (!response.ok) return emptyVideoOfTheDay();

    const data = await response.json();
    const latest = data?.resources?.[0];
    if (!latest?.secure_url) return emptyVideoOfTheDay();

    const video = {
      title: latest.public_id?.split("/").pop()?.replace(/[-_]/g, " ") || "Video of the Day",
      description: "",
      videoUrl: latest.secure_url,
      embedUrl: latest.secure_url,
      updatedAt: latest.created_at || new Date().toISOString(),
    };

    saveVideoOfTheDay(video);
    return video;
  } catch (error) {
    console.error("Cloudinary video fallback error:", error.message);
    return emptyVideoOfTheDay();
  }
};

const readVideoOfTheDay = async () => {
  const localVideo = readLocalVideoOfTheDay();
  if (localVideo.videoUrl) return localVideo;
  return fetchLatestCloudinaryVideo();
};

const getVideoEmbedUrl = (videoUrl) => {
  try {
    const parsed = new URL(videoUrl);
    let videoId = "";

    if (parsed.hostname.includes("youtu.be")) {
      videoId = parsed.pathname.replace("/", "");
    } else if (parsed.searchParams.get("v")) {
      videoId = parsed.searchParams.get("v") || "";
    } else if (parsed.pathname.includes("/shorts/")) {
      videoId = parsed.pathname.split("/shorts/")[1]?.split("/")[0] || "";
    } else if (parsed.pathname.includes("/embed/")) {
      videoId = parsed.pathname.split("/embed/")[1]?.split("/")[0] || "";
    }

    return videoId ? `https://www.youtube.com/embed/${videoId}` : videoUrl;
  } catch {
    return videoUrl;
  }
};

const requireAdmin = (req, res, next) => {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized admin request." });
  }

  next();
};

const donationConfig = {
  currency: (process.env.DONATION_CURRENCY || "eur").toLowerCase(),
  minimumDonation: Number(process.env.MINIMUM_DONATION || 1),
  stripeFeePercent: Number(process.env.STRIPE_FEE_PERCENT || 1.5),
  stripeFixedFee: Number(process.env.STRIPE_FIXED_FEE || 0.25),
  cryptoDeposits: [
    {
      label: process.env.CRYPTO_DEPOSIT_LABEL || "USDT (TRC20)",
      network: process.env.CRYPTO_NETWORK || "TRON (TRC20)",
      address: process.env.CRYPTO_DEPOSIT_ADDRESS || "TAVrMDcewAwwpPF8yuugtKsWu7SUpQa5fJ",
    },
  ],
  successUrl: process.env.STRIPE_SUCCESS_URL || "https://creo4real.com/success",
  cancelUrl: process.env.STRIPE_CANCEL_URL || "https://creo4real.com/cancel",
};

// 🔓 CORS (PRODUCTION SAFE)
app.use(cors({
  origin: function (origin, callback) {
    // allow tools like Postman / server-to-server requests
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
}));

// 🔓 Middleware
app.use(express.json());

// 🔍 Debug Stripe key
console.log(
  "Stripe key loaded:",
  process.env.STRIPE_SECRET_KEY ? "YES" : "NO"
);

// 🚀 Health check route
app.get("/", (req, res) => {
  res.send("Stripe server is running...");
});



// 🎬 PUBLIC VIDEO OF THE DAY
app.get("/video-of-the-day", async (req, res) => {
  const video = await readVideoOfTheDay();
  res.json(video);
});

// 🔐 ADMIN LOGIN
app.post("/admin/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin username or password." });
  }

  res.json({ token: ADMIN_TOKEN });
});

// ☁️ ADMIN CLOUDINARY SIGNED UPLOAD DETAILS
app.post("/admin/cloudinary-signature", requireAdmin, (req, res) => {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(500).json({
      message: "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render.",
    });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = CLOUDINARY_UPLOAD_FOLDER;
  const publicId = `video-of-the-day-${timestamp}`;
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash("sha1").update(paramsToSign).digest("hex");

  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    publicId,
  });
});

// 🎬 ADMIN UPDATE VIDEO OF THE DAY
app.put("/admin/video-of-the-day", requireAdmin, (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const videoUrl = String(req.body.videoUrl || "").trim();

  if (!videoUrl) {
    return res.status(400).json({ message: "Please enter a video URL." });
  }

  const video = {
    title: title || "Video of the Day",
    description,
    videoUrl,
    embedUrl: getVideoEmbedUrl(videoUrl),
    updatedAt: new Date().toISOString(),
  };

  saveVideoOfTheDay(video);
  res.json(video);
});

// 💳 DONATION SETTINGS FOR FRONTEND
app.get("/donation-config", (req, res) => {
  res.json({
    currency: donationConfig.currency.toUpperCase(),
    minimumDonation: donationConfig.minimumDonation,
    stripeFeePercent: donationConfig.stripeFeePercent,
    stripeFixedFee: donationConfig.stripeFixedFee,
    cryptoDeposits: donationConfig.cryptoDeposits,
  });
});

// 🪙 CREATE AUTOMATIC CRYPTO PAYMENT REQUEST
app.post("/create-crypto-payment", (req, res) => {
  try {
    const donationAmount = Number(req.body.amount);
    const depositAddress = String(req.body.depositAddress || donationConfig.cryptoDeposits[0].address).trim();
    const network = String(req.body.network || donationConfig.cryptoDeposits[0].network).trim();

    if (!donationAmount || donationAmount < donationConfig.minimumDonation) {
      return res.status(400).json({
        status: "failed",
        message: `Invalid donation amount. Minimum donation is ${donationConfig.minimumDonation} ${donationConfig.currency.toUpperCase()}.`,
      });
    }

    if (network !== donationConfig.cryptoDeposits[0].network || depositAddress !== donationConfig.cryptoDeposits[0].address) {
      return res.status(400).json({
        status: "failed",
        message: `Unsupported deposit option. Please use USDT on ${donationConfig.cryptoDeposits[0].network}.`,
      });
    }

    const now = Date.now();
    const payment = {
      paymentId: createPaymentId(),
      status: "waiting",
      message: "Send the exact USDT amount shown on the TRON (TRC20) network. The website will detect your payment automatically.",
      donationAmount,
      expectedTokenAmount: createUniqueExpectedAmount(donationAmount),
      depositAddress,
      network,
      createdAt: now,
      expiresAt: now + CRYPTO_PAYMENT_EXPIRY_MINUTES * 60 * 1000,
      transactionHash: undefined,
      amountReceived: undefined,
    };

    cryptoPayments.set(payment.paymentId, payment);
    res.json(publicCryptoPayment(payment));
  } catch (error) {
    console.error("Create crypto payment error:", error);
    res.status(500).json({
      status: "failed",
      message: "Unable to create an automatic crypto payment right now.",
    });
  }
});

// 🪙 CHECK AUTOMATIC CRYPTO PAYMENT STATUS
app.get("/crypto-payment-status/:paymentId", async (req, res) => {
  try {
    const payment = cryptoPayments.get(req.params.paymentId);

    if (!payment) {
      return res.status(404).json({
        status: "failed",
        message: "Crypto payment request not found. Please generate a new payment.",
      });
    }

    const updatedPayment = await updateAutomaticCryptoPaymentStatus(payment);
    res.json(publicCryptoPayment(updatedPayment));
  } catch (error) {
    console.error("Crypto payment status error:", error);
    res.status(500).json({
      status: "failed",
      message: "Unable to check the blockchain right now. Please try again.",
    });
  }
});

// 🪙 VERIFY CRYPTO PAYMENT ON TRON / TRC20
app.post("/verify-crypto-payment", async (req, res) => {
  try {
    const txHash = normalizeTxHash(req.body.txHash);
    const depositAddress = String(req.body.depositAddress || donationConfig.cryptoDeposits[0].address).trim();
    const network = String(req.body.network || donationConfig.cryptoDeposits[0].network).trim();

    if (!txHash || txHash.length < 32) {
      return res.status(400).json({
        status: "failed",
        message: "Invalid transaction hash / TXID. Please paste the full transaction hash from your wallet or exchange.",
      });
    }

    if (network !== donationConfig.cryptoDeposits[0].network) {
      return res.status(400).json({
        status: "failed",
        message: `Unsupported network. Please use ${donationConfig.cryptoDeposits[0].network}.`,
      });
    }

    const event = await findMatchingTransferEvent({ txHash, depositAddress });

    if (!event) {
      return res.json({
        status: "pending",
        message: "Payment not found yet for this deposit address. If you just paid, wait a few moments for the TRON network to update, then verify again.",
        transactionUrl: `https://tronscan.org/#/transaction/${txHash}`,
      });
    }

    const amountReceived = getTransferAmount(event);

    return res.json({
      status: "confirmed",
      message: "USDT TRC20 payment found on the TRON blockchain and sent to the correct deposit address.",
      amountReceived: amountReceived.toFixed(6).replace(/\.?(0+)$/, ""),
      token: CRYPTO_TOKEN_SYMBOL,
      transactionUrl: `https://tronscan.org/#/transaction/${txHash}`,
    });
  } catch (error) {
    console.error("Crypto verification error:", error);
    return res.status(500).json({
      status: "failed",
      message: "Unable to verify this crypto payment right now. Please check the TXID and try again.",
    });
  }
});

// 💳 CREATE CHECKOUT SESSION
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("Request body:", req.body);

    const amount = Number(req.body.amount);

    // ❌ Validate amount
    if (!amount || amount < donationConfig.minimumDonation) {
      return res.status(400).json({
        error: `Invalid donation amount. Minimum donation is ${donationConfig.minimumDonation} ${donationConfig.currency.toUpperCase()}.`,
      });
    }

    // 💳 Stripe Checkout card payment.
    // Card-only setup avoids rejected Stripe automatic payment-method parameters.
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: donationConfig.currency,
            product_data: {
              name: "CREO4REAL Donation",
              description: "Donation supporting the CREO4REAL mission",
            },
            unit_amount: Math.round(amount * 100), // euros → cents
          },
          quantity: 1,
        },
      ],

      metadata: {
        donationAmount: amount.toFixed(2),
        estimatedStripeFee: (
          amount * (donationConfig.stripeFeePercent / 100) +
          donationConfig.stripeFixedFee
        ).toFixed(2),
      },

      success_url: donationConfig.successUrl,
      cancel_url: donationConfig.cancelUrl,
    });

    console.log("Session created:", session.url);

    res.json({ url: session.url });

  } catch (error) {
    console.error("🔥 Stripe Error:", error.message);

    res.status(500).json({
      error: error.message,
    });
  }
});

// 🚀 PORT (Render safe)
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
