// Only the standalone HTML build defines this flag. Normal builds retain USD.
export const supportsUSD = !(typeof __OFFLINE_HTML__ !== 'undefined' && __OFFLINE_HTML__);
export const isUSDFile = name => /\.(usd|usda|usdc|usdz)$/i.test(name);
