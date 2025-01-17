const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, saveToken, isTokenExpired, saveJson, updateEnv } = require("./utils");
const { checkBaseUrl } = require("./checkAPI");
const headers = require("./core/header");

class ClientAPI {
  constructor(accountIndex, initData, session_name, baseURL, token) {
    this.accountIndex = accountIndex;
    this.queryId = initData;
    this.headers = headers;
    this.session_name = session_name;
    this.session_user_agents = this.#load_session_data();
    this.baseURL = baseURL;
    this.token = token;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    this.log(`Create user agent...`);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `"Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Account ${this.accountIndex + 1}]`;
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
      Authorization: `tma ${this.queryId}`,
    };

    if (!isAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          data,
          headers,
          timeout: 30000,
        });
        success = true;
        if (response.data) return { success: true, data: response.data };
        return { success: false, data: response.data };
      } catch (error) {
        if (error.status == 400) {
          return { success: false, error: error.message };
        }
        this.log(`Request failedi: ${url} | ${error.message} | trying again...`, "warning");
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { success: false, error: error.message };
      }
      currRetries++;
    } while (currRetries <= retries && !success);
  }

  async auth() {
    return this.makeRequest(`${this.baseURL}/auth/create-user`, "post", { refCode: settings.REF_ID || "Iil4QcC4TF" }, { isAuth: true });
  }

  async getUserInfo() {
    return this.makeRequest(`${this.baseURL}/user`, "get");
  }

  async getUserId() {
    return this.makeRequest(`${this.baseURL}/user/user-id`, "get");
  }

  async getQuests() {
    return this.makeRequest(`${this.baseURL}/user/quest`, "get");
  }

  async completeTask(payload) {
    return this.makeRequest(`${this.baseURL}/user/do-quest`, "post", payload);
  }

  async claimTask(payload) {
    return this.makeRequest(`${this.baseURL}/user/sucess-quest`, "post", payload);
  }

  async getValidToken() {
    const userId = this.session_name;
    const existingToken = this.token;
    let loginResult = null;

    const isExp = isTokenExpired(existingToken);
    if (existingToken && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    } else {
      this.log("Token not found or expired, logging in...", "warning");
      loginResult = await this.auth();
    }

    if (loginResult?.success) {
      const { token } = loginResult?.data;
      if (token) {
        saveToken(userId, token);
        this.token = token;
      }

      return token;
    } else {
      this.log(`Can't get token, try get new query_id!`, "warning");
    }
    return null;
  }

  async handleQuests() {
    const quests = await this.getQuests();
    if (quests.success) {
      let tasks = quests.data;
      tasks = tasks.filter((t) => !t.isDone && !settings.SKIP_TASKS.includes(t.id));
      if (tasks.length > 0) {
        for (const task of tasks) {
          await sleep(2);
          let res = { success: false, data: null };
          if (!task.isDoing) {
            this.log(`Completing task ${task.id} | ${task.name}...`);
            res = await this.completeTask({ questId: task.id });
          }
          if (res.success || task.isDoing) {
            await sleep(5);
            res = await this.claimTask({ questId: task.id });
            if (res.success) {
              this.log(`Task ${task.id} | ${task.name} completed successfully!`, "success");
            }
          }
        }
      } else {
        return this.log(`No tasks available!`, "warning");
      }
    }
  }
  async processAccount() {
    const token = await this.getValidToken();
    if (!token) return this.log(`Can't get token for account ${this.accountIndex + 1}, skipping...`, "error");

    let userData = { success: false, data: null },
      retries = 0;
    do {
      userData = await this.getUserInfo();
      if (userData?.success) break;
      retries++;
    } while (retries < 2);

    if (userData.success) {
      const { userBalances, user } = userData.data;
      const balanceTon = userBalances[0];
      const balanceHigh = userBalances[1];
      const balanceWater = userBalances[2];

      this.log(
        `User: ${user.userName} | Ton: [${balanceTon.pending} pending - ${balanceTon.unprocessed} unprocessed - ${balanceTon.used} - used] | High: [${balanceHigh.pending} pending - ${balanceHigh.unprocessed} unprocessed - ${balanceHigh.used} - used] | Water: [${balanceWater.pending} pending - ${balanceWater.unprocessed} unprocessed - ${balanceWater.used} - used]`
      );

      // if (settings.AUTO_TASK) {
      //   await this.handleQuests();
      // }

      //
      //start processing here================
      //
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function main() {
  console.log(colors.yellow("Tool developed by tele group Airdrop Hunter Super Speed (https://t.me/AirdropScript6)"));

  const { endpoint: hasIDAPI, message } = await checkBaseUrl();
  if (!hasIDAPI) return console.log(`API ID not found, try again later!`.red);
  console.log(`${message}`.yellow);

  const data = loadData("data.txt");
  const tokens = require("./token.json");

  const maxThreads = settings.MAX_THEADS_NO_PROXY;
  while (true) {
    for (let i = 0; i < data.length; i += maxThreads) {
      const batch = data.slice(i, i + maxThreads);

      const promises = batch.map(async (initData, indexInBatch) => {
        const accountIndex = i + indexInBatch;
        const userData = JSON.parse(decodeURIComponent(initData.split("user=")[1].split("&")[0]));
        const firstName = userData.first_name || "";
        const lastName = userData.last_name || "";
        const session_name = userData.id;

        console.log(`=========Account ${accountIndex + 1}| ${firstName + " " + lastName}`.green);
        const client = new ClientAPI(accountIndex, initData, session_name, hasIDAPI, tokens[session_name]);
        client.set_headers();

        return timeout(client.processAccount(), 24 * 60 * 60 * 1000).catch((err) => {
          client.log(`Account processing error: ${err.message}`, "error");
        });
      });
      await Promise.allSettled(promises);
    }
    await sleep(5);
    console.lo g(`Complete all accounts | Wait ${settings.TIME_SLEEP} minute=============`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

function timeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout"));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
