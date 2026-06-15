<div align="center">
  <img src="media/stavreng-icon.png" width="150" alt="Stavreng Logo">
  
  <h1>Stavreng</h1>
  
  <p><strong>The ultimate AI-Agent oversight and tracking extension for VS Code (and compatible IDEs).</strong></p>
  <p>Stop letting AI agents blindly overwrite your codebase. Stavreng gives you full transparency and granular control over every single line of code your AI tries to modify. It works seamlessly for tracking agents running natively in VS Code extensions (like Cline or RooCode) as well as any standard CLI coding agent (like Claude Code, Aider, etc.) running in your terminal. Works seamlessly in VS Code, Antigravity, Cursor, VSCodium, and other compatible IDEs.</p>
</div>

---

## ✨ Why Stavreng?
When you run a coding agent in a standard terminal or via a VS Code extension, it edits your files directly on disk. If it makes a mistake, clobbers a recent change you made, or rewrites a function poorly, your only defense is digging through `git diff` manually or relying on massive `git undo` commands that wipe out your own manual work too.

Stavreng fixes this by intercepting those changes locally and treating them as **"Pending Proposals"**.

## 🚀 Key Features

*   **Integrated Agent Terminal UI:** Run `claude`, `agy`, `aider`, or any local LLM interactive CLI natively inside the Stavreng sidebar.
*   **Granular File Review & Diffing:** Click on any file in the "Pending" state within the Stavreng sidebar to instantly open a side-by-side diff. Compare the exact "baseline" state of the file before the AI touched it against the AI's live changes.
*   **Surgical Rollbacks (Hunk-by-Hunk):** Don't like a specific loop the AI wrote? Review the diff and click "Reject" to surgically roll back *just that code block* without losing the manual edits you made somewhere else in the file! (All accepts and rejects update the live editor in real-time).
*   **Session Timeline:** A visual, interactive history of every AI session. Safely open previous sessions to read chat logs or review past file modifications.

## 📦 Installation

You can install Stavreng directly from the VS Code Marketplace:

1. Open VS Code and go to the **Extensions** panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Stavreng**.
3. Click **Install**.

*(Alternatively, you can download the latest `.vsix` file from the [Releases](https://github.com/samuelhorjet/stavreng/releases/) page and install it manually via "Install from VSIX" in the Extensions panel).*

## 🎯 How to Use

1.  Open the Stavreng icon in your VS Code Activity Bar.
    * **Pro Tip:** For the best agentic workflow, right-click the Stavreng icon and select **Move to Secondary Side Bar**. This allows you to keep your main file explorer open on the left while tracking the AI on the right!
2.  **Start a Tracking Session:**
    * **For Terminal CLI Agents:** Click the "Launch" button to start an agent, or type the command (like `claude`) natively in the integrated terminal. Stavreng will automatically detect the CLI agent and start tracking.
    * **For VS Code Extension Agents:** Because extensions run natively and edit files without an interactive shell, Stavreng cannot automatically detect when they are running. You must manually click the **Track** button at the top of the session panel to start a session *before* prompting your extension agent.
3.  Ask the AI to build something!
4.  As the AI modifies your files, you will see the changes tracked in the UI above the terminal as "Pending".
5.  Click a specific file to review the diff side-by-side. Use the **Accept All** (check) or **Reject All** (trash) buttons to approve or revert changes.
6.  When you are done, click **New Terminal** or toggle off the **Track** button to safely clear the session and start fresh.

## ⚠️ Important Cautions & Best Practices

* **Resolve Pending Changes First:** After an AI agent makes edits to a file, always make sure to either **Accept** or **Reject** those changes *before* editing those same files directly (especially the lines of code modified by the agent). Resolving pending agent modifications first ensures the local tracker remains in sync and prevents conflicts between manual edits and the AI's proposal.

## 🤝 Contributing

We welcome open-source contributions! To get started:
1. Clone this repository.
2. Run `npm install` to grab the dependencies.
3. Run `npm run compile` to build the extension.
4. Press `F5` in VS Code to launch the Extension Development Host and test your changes live.

---
**License:** MIT
