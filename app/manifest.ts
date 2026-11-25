import type { MetadataRoute } from "next";

// Lets people "Add to Home Screen" and get a proper app icon and name.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Liftoffle",
    short_name: "Liftoffle",
    description: "Name the thing nobody else will. The daily rare-answer word game.",
    start_url: "/",
    display: "standalone",
    background_color: "#05060f",
    theme_color: "#05060f",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
