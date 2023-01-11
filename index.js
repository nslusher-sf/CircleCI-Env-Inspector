import inquirer from "inquirer";
import {
  exitWithError,
  getCollaborations,
  getContexts,
  getContextVariables,
  getRepos,
  getProjectVariables,
  resolveVcsSlug,
  getSshCheckoutKeys,
  getAdditionalSshKeys
} from "./utils.js";
import * as fs from "fs";

const CIRCLE_V1_API =
  process.env.CIRCLE_V1_API ?? "https://circleci.com/api/v1.1";
const CIRCLE_V2_API =
  process.env.CIRCLE_v2_API ?? "https://circleci.com/api/v2";
const GITHUB_API = process.env.GITHUB_API ?? "https://api.github.com";

const USER_DATA = {
  contexts: [],
  projects: [],
  unavailable: [],
};

// Enter CircleCI Token if none is set
const CIRCLE_TOKEN =
  process.env.CIRCLE_TOKEN ||
  (
    await inquirer.prompt([
      {
        message: "Enter your CircleCI API token",
        type: "password",
        name: "cciToken",
      },
    ])
  ).cciToken;

// Select VCS
const VCS = (
  await inquirer.prompt([
    {
      message: "Select a VCS",
      type: "list",
      name: "vcs",
      choices: ["GitHub", "Bitbucket"],
    },
  ])
).vcs;

// Enter GitHub Token if none is set
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN ||
  (
    await inquirer.prompt([
      {
        message: "Enter your GitHub API token",
        type: "password",
        name: "ghToken",
        when: VCS === "GitHub",
      },
    ])
  ).ghToken;

const { response: resCollaborations, responseBody: collaboratorList } =
  await getCollaborations(CIRCLE_V2_API, CIRCLE_TOKEN);
if (resCollaborations.status !== 200)
  exitWithError(
    "Failed to get collaborations with the following error:\n",
    collaboratorList
  );
else if (collaboratorList.length === 0)
  exitWithError(
    "There are no organizations of which you are a member or a collaborator",
    collaboratorList
  );

const filteredAccounts = collaboratorList.filter(account => VCS.toLowerCase() === account['vcs_type'].toLowerCase());
const accountNames = filteredAccounts.reduce((acc, curr) => [curr.name, ...acc], [])
const answers = await inquirer.prompt([
  {
    message: "Select an account",
    type: "list",
    name: "account",
    choices: accountNames,
  },
  {
    message: "Is this an Organization (Not a User)?",
    type: "confirm",
    name: "isOrg",
    when: VCS === "GitHub",
  },
]);

const accountID = collaboratorList.find(
  (collaboration) => collaboration.name === answers.account
).id;

const getPaginatedData = async (api, token, identifier, caller) => {
  const items = [];
  let pageToken = "";

  do {
    const { response, responseBody } = await caller(
      api,
      token,
      identifier,
      pageToken
    );
    if (response.status !== 200)
      exitWithError(
        "Failed to get data with the following error:\n",
        responseBody
      );
    if (responseBody.items.length > 0) items.push(...responseBody.items);
    pageToken = responseBody.next_page_token;
  } while (pageToken);

  return items;
};
console.log("Getting Contexts Data...");
const contextList = await getPaginatedData(
  CIRCLE_V2_API,
  CIRCLE_TOKEN,
  accountID,
  getContexts
);
const contextData = await Promise.all(
  contextList.map(async (context) => {
    const variables = await getPaginatedData(
      CIRCLE_V2_API,
      CIRCLE_TOKEN,
      context.id,
      getContextVariables
    );
    return {
      name: context.name,
      id: context.id,
      variables,
    };
  })
);
USER_DATA.contexts = contextData;

console.log("Getting Projects Data...");
const getRepoList = async (api, token, accountName) => {
  const items = [];
  const slug = answers.isOrg ? `orgs/${accountName}` : "user";
  const source = VCS === "GitHub" ? "github" : "circleci";
  let pageToken = 1;
  let keepGoing = true;

  do {
    const { response, responseBody } = await getRepos(
      api,
      token,
      slug,
      pageToken
    );
    if (response.status !== 200)
      exitWithError(
        "Failed to get repositories with the following error:\n",
        responseBody
      );

    const reducer =
      VCS === "GitHub"
        ? (acc, curr) => [...acc, curr.full_name]
        : (acc, curr) => [...acc, `${curr.username}/${curr.vcs_url.replace(`https://bitbucket.org/${accountName}/`, "")}`];

    let results = responseBody;
    if (VCS === "Bitbucket") {
      results = responseBody.filter(r => r.username === accountName);
    }
    if (results.length > 0)
      items.push(...results.reduce(reducer, []));
    // CircleCI only requires one request to get all repos.
    if (results.length === 0 || source === "circleci") keepGoing = false;
    pageToken++;
  } while (keepGoing);

  return items;
};
const repoList =
  VCS === "GitHub"
    ? await getRepoList(GITHUB_API, GITHUB_TOKEN, answers.account)
    : await getRepoList(CIRCLE_V1_API, CIRCLE_TOKEN, answers.account);

console.log("Getting Projects Variables and SSH Keys...");
let unavailable = new Object();
const repoData = await Promise.all(
  repoList.map(async (repo) => {
    let unavailableReasons = [];
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000)));
    const vcsSlug = resolveVcsSlug(VCS);
    let resProjectVars = await getProjectVariables(
      CIRCLE_V2_API,
      CIRCLE_TOKEN,
      repo,
      vcsSlug
    );
    if (resProjectVars.response.status === 429) {
      let waitTime = 1;
      let multiplier = 2;
      let count = 0;
      let maxWait = 300;
      let maxRetries = 30;
      do {
        const retryAfterHeader =
          resProjectVars.response.headers.get("retry-after");
        const retryAfter =
          !retryAfterHeader && retryAfterHeader > 0
            ? retryAfterHeader
            : waitTime;
        console.dir(`Waiting ${retryAfter} seconds. Retry #${count}`);
        resProjectVars = await getProjectVariables(
          CIRCLE_V2_API,
          CIRCLE_TOKEN,
          repo,
          vcsSlug,
          retryAfter
        );
        if (waitTime < maxWait) waitTime *= multiplier;
      } while (resProjectVars.response.status === 429 && count++ < maxRetries);
    }
    if (resProjectVars.response.status != 200)
        unavailableReasons.push(`Project environment variables: ${resProjectVars.response.status} - ${resProjectVars.response.statusText}`);

    let sshCheckoutKeys = await getSshCheckoutKeys(
        CIRCLE_V2_API,
        CIRCLE_TOKEN,
        vcsSlug,
        repo
    );
    if (sshCheckoutKeys.response.status === 429) {
      let waitTime = 1;
      let multiplier = 2;
      let count = 0;
      let maxWait = 300;
      let maxRetries = 30;
      do {
        const retryAfterHeader =
            resProjectVars.response.headers.get("retry-after");
        const retryAfter =
            !retryAfterHeader && retryAfterHeader > 0
                ? retryAfterHeader
                : waitTime;
        console.dir(`Waiting ${retryAfter} seconds. Retry #${count}`);
        sshCheckoutKeys = await getSshCheckoutKeys(
            CIRCLE_V2_API,
            CIRCLE_TOKEN,
            vcsSlug,
            repo
        );
        if (waitTime < maxWait) waitTime *= multiplier;
      } while (sshCheckoutKeys.response.status === 429 && count++ < maxRetries);
    }
    if (sshCheckoutKeys.response.status != 200)
        unavailableReasons.push(`SSH checkout keys: ${sshCheckoutKeys.response.status} - ${sshCheckoutKeys.response.statusText}`);
    if (sshCheckoutKeys.response.status === 200 && sshCheckoutKeys.responseBody.next_page_token != null)
      throw new Error("Paging for getSshCheckoutKeys not yet implemented.");

    let additionalSshKeys = await getAdditionalSshKeys(
      CIRCLE_V1_API,
      CIRCLE_TOKEN,
      VCS.toLowerCase(),
      repo
    );
    if (additionalSshKeys.response.status === 429) {
      let waitTime = 1;
      let multiplier = 2;
      let count = 0;
      let maxWait = 300;
      let maxRetries = 30;
      do {
        const retryAfterHeader =
            resProjectVars.response.headers.get("retry-after");
        const retryAfter =
            !retryAfterHeader && retryAfterHeader > 0
                ? retryAfterHeader
                : waitTime;
        console.dir(`Waiting ${retryAfter} seconds. Retry #${count}`);
        additionalSshKeys = await getAdditionalSshKeys(
            CIRCLE_V1_API,
            CIRCLE_TOKEN,
            VCS.toLowerCase(),
            repo
        );
        if (waitTime < maxWait) waitTime *= multiplier;
      } while (additionalSshKeys.response.status === 429 && count++ < maxRetries);
    }
    if (additionalSshKeys.response.status != 200)
        unavailableReasons.push(`Additional SSH keys: ${additionalSshKeys.response.status} - ${additionalSshKeys.response.statusText}`);
    if (unavailableReasons.length > 0)
        unavailable[repo] = unavailableReasons;

    USER_DATA.unavailable = unavailable;
    return { name: repo, variables: resProjectVars?.responseBody?.items,
      sshCheckoutKeys: sshCheckoutKeys?.responseBody?.items,
      additionalSshKeys: additionalSshKeys?.responseBody?.ssh_keys
    };
  })
);
USER_DATA.projects = repoData.filter((repo) => repo?.variables?.length > 0 || repo?.sshCheckoutKeys?.length > 0);

fs.writeFileSync("circleci-data.json", JSON.stringify(USER_DATA, null, 2));
console.log("Log created at circleci-data.json");
