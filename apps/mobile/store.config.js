// App Store listing, pushed with `npx eas-cli metadata:push` (see README, "Store listing").
// Review contact and demo account come from the environment so they stay out of git:
// APP_REVIEW_FIRST_NAME, APP_REVIEW_LAST_NAME, APP_REVIEW_EMAIL, APP_REVIEW_PHONE,
// APP_REVIEW_DEMO_EMAIL, APP_REVIEW_DEMO_PASSWORD.

// The store name; change it here (and in app.config.ts) if the product is renamed.
const NAME = "Myrel";
const SITE = "https://myrel.fibteq.io";

const urls = {
  marketingUrl: SITE,
  supportUrl: `${SITE}/support/`,
  privacyPolicyUrl: `${SITE}/privacy/`,
};

const shots = (lang) => ({
  APP_IPHONE_67: [1, 2, 3, 4, 5].map((n) => `./store/screenshots/ios-6.9/${lang}/0${n}.png`),
  APP_IPAD_PRO_3GEN_129: [1, 2, 3, 4, 5].map((n) => `./store/screenshots/ios-ipad-13/${lang}/0${n}.png`),
});

const tr = {
  title: NAME,
  subtitle: "Yapay zekâ ajanlarıyla çalış",
  promoText: "Projeni anlat, işi thread'lere bölen koordinatör ve görevleri yürüten ajanlar gerisini halletsin. Karar gerektiğinde telefonuna bildirim gelir.",
  keywords: ["yapay zeka", "ajan", "AI", "proje", "kod", "github", "asistan", "ekip", "otomasyon", "sohbet", "görev"],
  description: `${NAME}, projelerinde yapay zekâ ajanlarıyla birlikte çalıştığın bir çalışma alanı.

Projene ne istediğini yaz; koordinatör işi parçalara ayırır ve her parça için bir thread açar. Her thread'de bir ajan araştırır, kod yazar, pull request açar, belge ve artifact üretir. Sen de nerede olursan ol ilerlemeyi takip edersin.

TELEFONUNDAN NELER YAPABİLİRSİN
• Projelerini ve koordinatörle sohbetini görürsün, yeni iş verirsin.
• Her thread'in ilerleme listesini canlı izlersin.
• Ajan bir karar beklediğinde bildirim alır, seçeneklerden birine tek dokunuşla cevap verirsin.
• Ajanların ürettiği artifact'leri, dosyaları ve pull request'leri açarsın.
• Token kullanımını ve maliyeti proje bazında görürsün.
• Ekibini projeye davet eder, birlikte çalışırsın.

AÇIK KAYNAK
Myrel açık kaynaklı. myrel.fibteq.io'yu kullanabilir ya da uygulamayı kendi kurduğun Myrel sunucusuna bağlayabilirsin.

Gizlilik: ${urls.privacyPolicyUrl}
Kullanım şartları: ${SITE}/terms/`,
  releaseNotes: "Myrel'in ilk sürümü.",
  ...urls,
  screenshots: shots("tr"),
};

const en = {
  title: NAME,
  subtitle: "Work alongside your AI agents",
  promoText: "Describe the work; a coordinator splits it into threads and agents carry out each one. When a decision needs you, it lands on your phone.",
  keywords: ["assistant", "chatbot", "projects", "coding", "developer", "github", "team", "automation", "tasks", "workflow", "productivity"],
  description: `${NAME} is a workspace where you work on projects together with AI agents.

Tell your project what you need; the coordinator breaks the work down and opens a thread for each part. In every thread an agent researches, writes code, opens pull requests and produces documents and artifacts, while you follow along from wherever you are.

FROM YOUR PHONE YOU CAN
• See your projects and your conversation with the coordinator, and hand out new work.
• Follow each thread's progress checklist live.
• Get notified when an agent needs a decision, and answer with one tap.
• Open the artifacts, files and pull requests the agents produce.
• See token usage and cost per project.
• Invite your team to a project and work together.

OPEN SOURCE
Myrel is open source. Use myrel.fibteq.io, or connect the app to a Myrel server you run yourself.

Privacy: ${urls.privacyPolicyUrl}
Terms: ${SITE}/terms/`,
  releaseNotes: "The first release of Myrel.",
  ...urls,
  screenshots: shots("en"),
};

const env = process.env;

/** @type {import('eas-cli/schema/metadata-0.json')} */
module.exports = {
  configVersion: 0,
  apple: {
    copyright: `${new Date().getFullYear()} Fibteq`,
    categories: ["DEVELOPER_TOOLS", "PRODUCTIVITY"],
    info: { tr, "en-US": en },
    advisory: {
      alcoholTobaccoOrDrugUseOrReferences: "NONE",
      contests: "NONE",
      gamblingSimulated: "NONE",
      gunsOrOtherWeapons: "NONE",
      horrorOrFearThemes: "NONE",
      matureOrSuggestiveThemes: "NONE",
      medicalOrTreatmentInformation: "NONE",
      profanityOrCrudeHumor: "NONE",
      sexualContentGraphicAndNudity: "NONE",
      sexualContentOrNudity: "NONE",
      violenceCartoonOrFantasy: "NONE",
      violenceRealistic: "NONE",
      violenceRealisticProlongedGraphicOrSadistic: "NONE",
      gambling: false,
      lootBox: false,
      advertising: false,
      // Artifacts open inside the app, but only pages the project's agents made, not the open web.
      unrestrictedWebAccess: false,
      // Project members message each other and the agents; AI output is generated content.
      messagingAndChat: true,
      userGeneratedContent: true,
      healthOrWellnessTopics: false,
      parentalControls: false,
      ageAssurance: false,
      kidsAgeBand: null,
      ageRatingOverride: "NONE",
      koreaAgeRatingOverride: "NONE",
    },
    release: { automaticRelease: false, phasedRelease: false },
    review: {
      firstName: env.APP_REVIEW_FIRST_NAME ?? "",
      lastName: env.APP_REVIEW_LAST_NAME ?? "",
      email: env.APP_REVIEW_EMAIL ?? "",
      phone: env.APP_REVIEW_PHONE ?? "",
      demoRequired: true,
      demoUsername: env.APP_REVIEW_DEMO_EMAIL ?? "",
      demoPassword: env.APP_REVIEW_DEMO_PASSWORD ?? "",
      // The App Review Notes, kept the same as app-store-2-1/notes.md in the project files: every
      // `eas-cli metadata:push` writes this over the Notes in App Store Connect. [Brackets] are filled
      // in before a submission.
      notes: [
        "DEMO ACCOUNT",
        "Use the account in Sign-In Information. The server myrel.fibteq.io is preselected. One account type; plans (Free, Pro) only change usage limits. The demo account is on Free so In-App Purchase can be tested.",
        "",
        "SCREEN RECORDING",
        "[VIDEO LINK]",
        "",
        "WHAT MYREL IS",
        "A workspace for running projects with AI agents, for adult developers, makers and small teams. You describe the work in a project's conversation; an AI coordinator splits it into task threads where agents research, write code, open pull requests and produce documents. The app lets you follow progress, answer the agents' questions and review results from your phone.",
        "",
        "HOW TO TRY IT",
        "1. Sign in, open the project \"Demo\" (tabs: Conversation, Threads, Artifacts, Files, Usage).",
        "2. Send a message in Conversation, e.g. \"Write a one-page README for a to-do app\". The coordinator answers within a minute and opens a thread; tap it to follow the agent.",
        "3. Settings (gear icon on Projects): Plan and billing (Pro via In-App Purchase), Sign out, Delete account.",
        "4. Report content: [long-press a message > Report]. Block a member: [Members > name > Block].",
        "No sample files are needed.",
        "",
        "EXTERNAL SERVICES",
        "- Cloudflare: hosting, database, file storage, cloud sandboxes for agents, sign-in emails, Turnstile on sign-up.",
        "- Fireworks AI: AI model inference (open-weight models). Projects may use their own Anthropic or OpenAI key instead.",
        "- Open-source coding agent tools (OpenCode, Claude Code, Codex CLI) inside the sandbox, using those models.",
        "- Authentication: email and password on our own server; no third-party sign-in.",
        "- Payments: Apple In-App Purchase through RevenueCat.",
        "- Push: Expo Push Service and APNs.",
        "- Optional, user-connected: GitHub, Model Context Protocol tools, the user's own computer via our open-source runner.",
        "",
        "REGIONS",
        "Same features and content in every storefront where the app is offered; only prices are local. English and Turkish. [Not offered in China mainland.]",
        "",
        "REGULATION AND CONTENT",
        "Not a regulated industry; no protected third-party material. Projects are private and invite-only; content is visible only to project members. Reports are reviewed within 24 hours; owners can remove members. Terms: https://myrel.fibteq.io/terms/ Privacy: https://myrel.fibteq.io/privacy/ Support: myrel@fibteq.io",
        "",
        "Developer: Fibteq. Source code: AGPL-3.0.",
      ].join("\n"),
    },
  },
};
