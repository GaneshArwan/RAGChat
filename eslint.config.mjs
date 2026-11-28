import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: [".next/**", "node_modules/**", "chroma_data/**", ".tmp-test/**", "services/**"],
  },
];

export default eslintConfig;
