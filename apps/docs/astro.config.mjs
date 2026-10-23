import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const repo = "https://github.com/Fibteq-Inc/myrel";

export default defineConfig({
  site: process.env.DOCS_SITE ?? "https://docs.myrel.fibteq.io",
  // The first version of the guide had these pages; old links keep working.
  redirects: {
    "/getting-started/": "/get-started/quickstart/",
    "/guides/projects-and-threads/": "/work/threads/",
    "/guides/using-your-computer/": "/computer/connect/",
    "/guides/github-integration/": "/github/connect/",
    "/faq/": "/help/faq/",
  },
  integrations: [
    starlight({
      title: "Myrel Docs",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      description: "How to use Fibteq Myrel: projects, threads, your computer and GitHub.",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/docs/` },
      lastUpdated: true,
      sidebar: [
        { label: "Get started", items: ["index", "get-started/quickstart", "get-started/apps"] },
        { label: "Projects", items: ["projects/create", "projects/members", "projects/knowledge"] },
        {
          label: "Working with Myrel",
          items: ["work/asking", "work/threads", "work/decisions", "work/artifacts", "work/finishing"],
        },
        {
          label: "Your computer",
          items: ["computer/connect", "computer/folders", "computer/clis", "computer/approvals", "computer/runner"],
        },
        { label: "GitHub", items: ["github/connect", "github/pull-requests"] },
        {
          label: "Automate and extend",
          items: ["automate/routines", "automate/skills", "automate/connectors", "automate/notifications"],
        },
        { label: "Account", items: ["account/settings", "account/usage"] },
        { label: "Help", items: ["help/faq", "help/troubleshooting"] },
        {
          label: "In the repository",
          items: [
            { label: "Self-hosting", link: `${repo}/blob/main/docs/self-hosting.md`, attrs: { target: "_blank" } },
            { label: "Contributing", link: `${repo}/blob/main/CONTRIBUTING.md`, attrs: { target: "_blank" } },
            { label: "Security policy", link: `${repo}/blob/main/SECURITY.md`, attrs: { target: "_blank" } },
          ],
        },
      ],
    }),
  ],
});
