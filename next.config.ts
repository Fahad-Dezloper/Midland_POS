import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The stock sheet is read from disk at runtime, so it has to be traced into
  // the build output for the home page and the lookup routes.
  outputFileTracingIncludes: {
    "/": ["./data/stock-list.csv"],
    "/api/lookup/[isbn]": ["./data/stock-list.csv"],
    "/api/search": ["./data/stock-list.csv"],
    "/api/sales": ["./data/stock-list.csv"],
    "/api/bills/[orderId]": ["./data/stock-list.csv"],
  },
};

export default nextConfig;
