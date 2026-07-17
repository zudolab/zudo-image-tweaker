import { defineConfig } from "zfb/config";
import { zudoDoc } from "@takazudo/zudo-doc/config";

export default defineConfig(
  zudoDoc({
    siteName: "zudo-image-tweaker",
    siteDescription:
      "A sharp-based image-tweaking toolkit with eleven focused subpath modules.",
    siteUrl: "https://zudo-image-tweaker.takazudomodular.com",
    base: "/",
    githubUrl: "https://github.com/zudolab/zudo-image-tweaker",
    llmsTxt: true,
    imageEnlarge: true,
    dynamicPageTransition: true,
    claudeResources: {
      claudeDir: "../.claude",
      projectRoot: ".",
      scanRoot: "..",
    },
    defaultLocaleOnlyPrefixes: [
      "/docs/claude-md/",
      "/docs/claude-skills/",
      "/docs/claude-agents/",
      "/docs/claude-commands/",
    ],
    headerNav: [
      {
        label: "Getting Started",
        path: "/docs/getting-started",
        categoryMatch: "getting-started",
      },
      {
        label: "Guides",
        path: "/docs/guides",
        categoryMatch: "guides",
      },
      {
        label: "Claude",
        path: "/docs/claude",
        categoryMatch: "claude",
      },
      {
        label: "Reference",
        path: "/docs/reference",
        categoryMatch: "reference",
      },
    ],
    headerRightItems: [
      {
        type: "component",
        component: "github-link",
      },
      {
        type: "component",
        component: "theme-toggle",
      },
      {
        type: "component",
        component: "search",
      },
    ],
  }),
);
