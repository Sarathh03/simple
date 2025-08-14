import streamlit as st
from PIL import Image
import pytesseract
import subprocess
import tempfile
import os

# ---------------- CONFIG ---------------- #
OCR_LANG = "eng"
OLLAMA_MODEL = "llama3.2:latest"
PORT = 8000
PRIMARY_COLOR = "#000000"  # updated color
# ----------------------------------------- #

# Set page config without Streamlit logo and menu
st.set_page_config(
    page_title="Offline Image Code Fixer",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# Hide Streamlit's hamburger menu and footer
hide_streamlit_style = """
<style>
    #MainMenu {visibility: hidden;}
    footer {visibility: hidden;}
</style>
"""
st.markdown(hide_streamlit_style, unsafe_allow_html=True)

# Apply custom color theme
custom_style = f"""
<style>
    /* Background color for main content */
    .stApp {{
        background-color:#FFDFEF;
    }}

    /* Title color */
    h1 {{
        color: black;
    }}

    /* Subheaders color */
    h2, h3 {{
        color: black;
    }}

    /* Streamlit buttons */
    div.stButton > button {{
        background-color: black;
        color: white;
        border-radius: 8px;
    }}

    div.stButton > button:hover {{
        background-color: black; /* slightly darker on hover */
        color: white;
    }}

    /* File uploader */
    .stFileUploader > label {{
        color: black;
        font-weight: bold;
    }}
</style>
"""
st.markdown(custom_style, unsafe_allow_html=True)

st.markdown('<h1 style="color: black;">Offline Image Code Fixer</h1>', unsafe_allow_html=True)
st.markdown('<span style="color: black; font-size: 20px;">Upload an image containing code. We\'ll OCR it and attempt to fix it using Ollama locally.</span>', unsafe_allow_html=True)

uploaded_file = st.file_uploader(
    "Upload an image", type=["png", "jpg", "jpeg"], accept_multiple_files=False
)

if uploaded_file:
    # Display uploaded image with black caption
    st.image(uploaded_file, use_container_width=True)
    st.markdown('<span style="color: black; font-size: 18px;">Uploaded Code Image</span>', unsafe_allow_html=True)

    # OCR extraction
    image = Image.open(uploaded_file)
    extracted_code = pytesseract.image_to_string(image, lang=OCR_LANG)

    st.markdown('<h2 style="color: black;">Extracted Code from Image</h2>', unsafe_allow_html=True)
    st.code(extracted_code)

    st.markdown('<h2 style="color: black;">Fixed Code</h2>', unsafe_allow_html=True)

    if extracted_code.strip() == "":
        st.warning("No code detected in the image.")
    else:
        # Save OCR result to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, mode="w", encoding="utf-8", suffix=".txt") as tmp_file:
            tmp_file.write(extracted_code)
            tmp_file_path = tmp_file.name

        try:
            cmd = f'type "{tmp_file_path}" | ollama run {OLLAMA_MODEL}'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

            if result.returncode == 0:
                fixed_code = result.stdout
                if fixed_code.strip() == "":
                    st.warning("Ollama did not return any output. Check your model.")
                else:
                    st.code(fixed_code)
            else:
                st.error(f"Error running Ollama:\n{result.stderr}")

        except Exception as e:
            st.error(f"Exception occurred while running Ollama: {e}")

        finally:
            if os.path.exists(tmp_file_path):
                os.remove(tmp_file_path)
