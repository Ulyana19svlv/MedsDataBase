import { defineConfig } from "astro/config";

const site = "https://ulyana19svlv.github.io";
const base = "/MedsDataBase";

export default defineConfig({
  site,
  base,
  output: "static",
  trailingSlash: "never",
  vite: {
    server: {
      fs: {
        allow: [".."],
      },
    },
  },
});
