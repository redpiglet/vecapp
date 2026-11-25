# vecapp

The GitHub Pages demo uses an original sample carton and bag, with sample proportions and print surfaces. Visitors can try colors and logos in their browser. The build uses only the shared frontend, the sample catalog, and the sample model generator.

## Preview locally

From the repository root, build into a fresh directory and serve it with Python.

```sh
preview_dir=$(mktemp -d)
python3 tools/build_pages.py "$preview_dir/vecapp"
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$preview_dir"
```

Open [the local demo](http://127.0.0.1:8080/vecapp/). In the private workspace, run `python3 server.py` to use the production models, dielines, quote submission, and model review.

## Publish on GitHub Pages

The repository and the Pages build are both public. Keep production assets, product settings, review files, and quote data in the private workspace. The ignore file covers the current production paths.

1. In the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**.
2. Stage the demo inputs and review the staged files.

```sh
git add -- .gitignore .github/workflows/pages.yml README.md \
  app.js glb-model.js index.html renderer.js styles.css \
  tools/build_pages.py tools/demo_catalog.json tools/demo_models.py
git diff --cached --name-only
```

3. Commit and push to `main`.

```sh
git commit -m "Publish configurator demo with GitHub Pages"
git push origin main
```

The **Deploy configurator demo to GitHub Pages** workflow publishes the demo on pushes to `main`. After it succeeds, open [the GitHub Pages demo](https://redpiglet.github.io/vecapp/).
