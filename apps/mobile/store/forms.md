# Store forms

Paste-ready answers for the parts of the store consoles that `eas-cli metadata:push` does not fill:
the whole Google Play listing and its policy forms, and the App Store "App Privacy" questionnaire.
The App Store listing itself is in `../store.config.js`. If the product is renamed, change the name
here, in `store.config.js` and in `app.config.ts`.

Shared values:

| | |
|---|---|
| App name | Myrel |
| Website | https://myrel.fibteq.io |
| Support | https://myrel.fibteq.io/support/ · myrel@fibteq.app |
| Privacy policy | https://myrel.fibteq.io/privacy/ |
| Terms | https://myrel.fibteq.io/terms/ |
| Account deletion | https://myrel.fibteq.io/delete-account/ |
| Package / bundle id | io.fibteq.myrel (fixed after the first upload) |

## Google Play: main store listing

Category **Productivity**, tags: AI assistant, Productivity, Developer tools. Contact email myrel@fibteq.app,
website https://myrel.fibteq.io.

Graphics: icon `../assets/icon.png` scaled to 512x512, feature graphic `screenshots/feature-graphic-<lang>.png`,
phone screenshots `screenshots/android-phone/<lang>/`.

### Türkçe (tr-TR)

**Uygulama adı:** Myrel

**Kısa açıklama:** Yapay zekâ ajanlarıyla proje yürüt, ilerlemeyi ve kararları telefondan izle.

**Tam açıklama:**

```text
Myrel, projelerinde yapay zekâ ajanlarıyla birlikte çalıştığın bir çalışma alanı.

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

Gizlilik: https://myrel.fibteq.io/privacy/
Kullanım şartları: https://myrel.fibteq.io/terms/
```

### English (en-US)

**App name:** Myrel

**Short description:** Run projects with AI agents; follow progress and decisions from your phone.

**Full description:**

```text
Myrel is a workspace where you work on projects together with AI agents.

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

Privacy: https://myrel.fibteq.io/privacy/
Terms: https://myrel.fibteq.io/terms/
```

## Google Play: App content (Policy > App content)

**Privacy policy:** https://myrel.fibteq.io/privacy/

**Ads:** No, the app does not contain ads.

**App access:** All or some functionality is restricted. Add instructions:
- Name: Demo account
- Username / password: the demo account (same one as in the App Store review)
- Notes: "Server myrel.fibteq.io is preselected. Sign in, open the Demo project."

**Content rating (IARC questionnaire):** category *All Other App Types*. Answer No to violence, fear,
sexuality, gambling, language, controlled substances and crude humor. *Users can interact or exchange
content:* Yes (project members chat with each other and with AI agents). *Shares user's location:* No.
*Allows purchases of digital goods:* No. Expected result: Everyone / PEGI 3 with "Users Interact".

**Target audience and content:** 18 and over only. Not designed for children. Not in Designed for Families.

**News app:** No. **Government app:** No. **Financial features:** none. **Health:** none.
**COVID-19 contact tracing:** No. **Advertising ID:** No, the app does not use it.

**Data safety:**

- Does the app collect or share user data? **Yes, collects.** Shares: **No** (Cloudflare, the AI model
  providers, Expo, Apple and Google act as service providers, which Google does not count as sharing).
- Is all data encrypted in transit? **Yes.**
- Can users request that their data be deleted? **Yes**, in the app and at
  https://myrel.fibteq.io/delete-account/
- Data types (all *collected*, *not shared*, *processed ephemerally: No*, *required*):

| Category | Data type | Purposes |
|---|---|---|
| Personal info | Name | App functionality, Account management |
| Personal info | Email address | App functionality, Account management, Developer communications |
| Messages | Other in-app messages | App functionality |
| Files and docs | Files and docs | App functionality (optional: only when you upload files) |
| App activity | Other user-generated content | App functionality |
| App activity | Other actions (usage and cost per model call) | App functionality, Analytics |
| Device or other IDs | Device or other IDs (push token) | App functionality |

Not collected: location, financial info, health, contacts, calendar, photos/videos, audio, web
history, installed apps, crash logs, diagnostics.

**Account deletion:** URL https://myrel.fibteq.io/delete-account/ . In-app path: Projects > gear icon >
Delete account.

## Google Play: first release

Testing > Internal testing > Create new release > upload the `.aab` from EAS > release name `0.1.0` >
release notes:

```text
<tr-TR>
Myrel'in ilk sürümü.
</tr-TR>
<en-US>
The first release of Myrel.
</en-US>
```

After the first manual upload, later builds can go up with `npx eas-cli submit --platform android`
(needs a Play service account key in EAS credentials).

## App Store: App Privacy (App Store Connect > App Privacy)

Data collection: **Yes**. Tracking: **No** for every type (no ads, no data brokers, no cross-app tracking).

| Data type | Linked to user | Purposes |
|---|---|---|
| Contact Info > Name | Yes | App Functionality |
| Contact Info > Email Address | Yes | App Functionality |
| User Content > Other User Content (messages, files, artifacts) | Yes | App Functionality |
| User Content > Customer Support | Yes | App Functionality |
| Identifiers > User ID | Yes | App Functionality |
| Usage Data > Other Usage Data (usage and cost per model call) | Yes | App Functionality, Analytics |

Not collected: Health, Financial, Location, Sensitive Info, Contacts, Browsing/Search History,
Purchases, Diagnostics, Device ID.

## App Store: things `metadata:push` does not set

- Pricing and availability: Free, all countries (or the ones you choose).
- Export compliance is answered by `ITSAppUsesNonExemptEncryption: false` in the build.
- Content rights: the app does not contain third-party content it lacks the rights to.
- Pick the build under the version, then Add for Review.
