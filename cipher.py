import base64
import os
import tkinter as tk
from tkinter import messagebox

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# -----------------------------
# KEY DERIVATION
# -----------------------------
def derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=300000,
    )
    return kdf.derive(password.encode())


# -----------------------------
# ENCRYPTION
# -----------------------------
def encrypt_message(message: str, password: str) -> str:
    salt = os.urandom(16)
    nonce = os.urandom(12)

    key = derive_key(password, salt)

    aesgcm = AESGCM(key)

    ciphertext = aesgcm.encrypt(
        nonce,
        message.encode(),
        None
    )

    combined = salt + nonce + ciphertext

    return base64.b64encode(combined).decode()


# -----------------------------
# DECRYPTION
# -----------------------------
def decrypt_message(encrypted_text: str, password: str) -> str:
    data = base64.b64decode(encrypted_text)

    salt = data[:16]
    nonce = data[16:28]
    ciphertext = data[28:]

    key = derive_key(password, salt)

    aesgcm = AESGCM(key)

    plaintext = aesgcm.decrypt(
        nonce,
        ciphertext,
        None
    )

    return plaintext.decode()


# -----------------------------
# GUI FUNCTIONS
# -----------------------------
def encrypt_gui():
    try:
        message = input_text.get("1.0", tk.END).strip()
        password = key_entry.get()

        if not message or not password:
            messagebox.showerror("Error", "Text and key required.")
            return

        encrypted = encrypt_message(message, password)

        output_text.delete("1.0", tk.END)
        output_text.insert(tk.END, encrypted)

    except Exception as e:
        messagebox.showerror("Encryption Error", str(e))


def decrypt_gui():
    try:
        encrypted = input_text.get("1.0", tk.END).strip()
        password = key_entry.get()

        if not encrypted or not password:
            messagebox.showerror("Error", "Encrypted text and key required.")
            return

        decrypted = decrypt_message(encrypted, password)

        output_text.delete("1.0", tk.END)
        output_text.insert(tk.END, decrypted)

    except Exception:
        messagebox.showerror(
            "Decryption Error",
            "Wrong key or corrupted message."
        )


# -----------------------------
# GUI SETUP
# -----------------------------
root = tk.Tk()
root.title("Secure Message Encryptor")
root.geometry("700x500")

title = tk.Label(
    root,
    text="AES-256 Secure Messenger",
    font=("Arial", 16, "bold")
)
title.pack(pady=10)

key_label = tk.Label(root, text="Secret Key / Password:")
key_label.pack()

key_entry = tk.Entry(root, width=50, show="*")
key_entry.pack(pady=5)

input_label = tk.Label(root, text="Input Text:")
input_label.pack()

input_text = tk.Text(root, height=10, width=80)
input_text.pack(pady=5)

button_frame = tk.Frame(root)
button_frame.pack(pady=10)

encrypt_button = tk.Button(
    button_frame,
    text="Encrypt",
    command=encrypt_gui,
    width=20
)
encrypt_button.grid(row=0, column=0, padx=10)

decrypt_button = tk.Button(
    button_frame,
    text="Decrypt",
    command=decrypt_gui,
    width=20
)
decrypt_button.grid(row=0, column=1, padx=10)

output_label = tk.Label(root, text="Output:")
output_label.pack()

output_text = tk.Text(root, height=10, width=80)
output_text.pack(pady=5)

root.mainloop()