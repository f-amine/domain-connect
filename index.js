import { wrap, configure } from "agentql";
import { chromium } from "playwright";
import { unlinkSync } from "fs";

const sessions = new Map();

const LOGIN_URL = "https://www.namecheap.com/myaccount/login/";
const DNS_URL =
  "https://ap.www.namecheap.com/domains/domaincontrolpanel/{domain}/advancedns";

const LOGIN_QUERY = `
{
  login_form {
    username_input
    password_input
    signin_btn
  }
}
`;

const VERIFICATION_QUERY = `
{
  verification_form {
    code_input
    submit_btn
  }
}
`;

const ADD_RECORD_BTN_QUERY = `
{
  add_record_btn
}
`;

const CNAME_RECORD_QUERY = `
{
  record_type_cname_span
  host_input
  target_input
  add_new_record_btn
}
`;

async function initializeAuthentication(username, password, domain) {
  const browser = await chromium.launch({
    headless: false,
  });

  const page = await wrap(await browser.newPage());

  try {
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    const response = await page.queryElements(LOGIN_QUERY);

    await response.login_form.username_input.fill(username);
    await response.login_form.password_input.fill(password);
    await response.login_form.signin_btn.click();
    await page.waitForLoadState("networkidle");

    const sessionId = Math.random().toString(36).substring(7);

    sessions.set(sessionId, {
      browser,
      page,
      domain,
      username,
      timestamp: Date.now(),
    });

    return sessionId;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function completeAuthentication(sessionId, verificationCode) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found or expired");
  }

  const { page, domain } = session;

  try {
    await page.waitForLoadState("networkidle");

    const verificationResponse = await page.queryElements(VERIFICATION_QUERY);

    await verificationResponse.verification_form.code_input.fill(
      verificationCode,
    );

    await verificationResponse.verification_form.submit_btn.click();

    await page.waitForLoadState("networkidle");

    const dnsUrl = DNS_URL.replace("{domain}", domain);

    await page.goto(dnsUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await addCNAMERecord(authenticatedPage);

    return { success: true, message: "DNS record added successfully" };
  } catch (error) {
    throw error;
  } finally {
    if (session.browser) {
      await session.browser.close();
    }
    sessions.delete(sessionId);
    try {
      unlinkSync(`namecheap_auth_${sessionId}.json`);
    } catch (e) {
      console.error("Error cleaning up auth file:", e);
    }
  }
}

async function addCNAMERecord(page) {
  try {
    await page.waitForLoadState("networkidle");
    const response = await page.queryElements(ADD_RECORD_BTN_QUERY);
    console.log(response);
    await response.add_record_btn.click();

    const cNameResponse = await page.queryElements(CNAME_RECORD_QUERY);
    consoel.log(cNameResponse);
    await cNameResponse.record_type_cname_span.click();
    await cNameResponse.host_input.type("www");
    await cNameResponse.target_input.type("shop.mylightfunnels.com");
    await cNameResponse.add_new_record_btn.click();
    await page.waitForLoadState("networkidle");
  } catch (error) {
    throw error;
  }
}

// Clean up expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.timestamp > 5 * 60 * 1000) {
      if (session.browser) {
        session.browser.close();
      }
      sessions.delete(sessionId);
      try {
        unlinkSync(`namecheap_auth_${sessionId}.json`);
      } catch (e) {
        console.error("Error cleaning up auth file:", e);
      }
    }
  }
}, 60000);

// Configure AgentQL
const agentQlKey = process.env.AGENTQL_KEY;
if (!agentQlKey) {
  throw new Error("AGENTQL_KEY is not defined in the environment variables.");
}
configure({ apiKey: agentQlKey });

// Create Bun server
const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // Only accept POST requests
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    try {
      const body = await req.json();

      // Initialize authentication endpoint
      if (url.pathname === "/api/dns/init") {
        const { username, password, domain } = body;

        if (!username || !password || !domain) {
          return new Response(
            JSON.stringify({
              error: "Missing required fields: username, password, and domain",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        }

        try {
          const sessionId = await initializeAuthentication(
            username,
            password,
            domain,
          );
          return new Response(
            JSON.stringify({
              success: true,
              sessionId,
              message:
                "Authentication initiated. Please provide verification code.",
            }),
            {
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: "Failed to initialize authentication",
              message: error.message,
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        }
      }

      // Complete authentication endpoint
      if (url.pathname === "/api/dns/verify") {
        const { sessionId, verificationCode } = body;

        if (!sessionId || !verificationCode) {
          return new Response(
            JSON.stringify({
              error: "Missing required fields: sessionId and verificationCode",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        }

        try {
          const result = await completeAuthentication(
            sessionId,
            verificationCode,
          );
          return new Response(JSON.stringify(result), {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: "Failed to complete authentication and DNS setup",
              message: error.message,
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        }
      }

      // Handle unknown endpoints
      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        },
      );
    }
  },
});

console.log(`Server running at http://localhost:${server.port}`);
