import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const repo = "https://github.com/Fibteq-Inc/myrel";

export default defineConfig({
  site: process.env.DOCS_SITE ?? "https://docs.myrel.fibteq.io",
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
        { label: "Start here", items: ["index", "getting-started"] },
        {
          label: "Using Myrel",
          items: [
            "guides/projects-and-threads",
            "guides/using-your-computer",
            "guides/github-integration",
          ],
        },
        { label: "Help", items: ["faq"] },
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
