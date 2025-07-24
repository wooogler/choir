#!/usr/bin/env python3
"""
PDF to Markdown converter using markitdown.
"""

import sys
import os
import re
from pathlib import Path
from markitdown import MarkItDown

def clean_markdown_text(text: str) -> str:
    """
    Clean up markdown text by fixing formatting issues.
    
    Args:
        text: Raw markdown text
        
    Returns:
        Cleaned markdown text
    """
    # Remove excessive backslashes at line endings
    text = re.sub(r'\\\s*\n', '\n', text)
    
    # Fix double spaces
    text = re.sub(r'  +', ' ', text)
    
    # Remove standalone backslashes
    text = re.sub(r'(?<!\\)\\(?!\\)', '', text)
    
    # Clean up multiple consecutive newlines (keep max 2)
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    # Remove page numbers and headers/footers
    lines = text.split('\n')
    cleaned_lines = []
    
    for line in lines:
        stripped = line.strip()
        
        # Skip page numbers (single digits or numbers)
        if re.match(r'^\d+$', stripped):
            continue
            
        # Skip headers with manual title and page info
        if re.match(r'^\d{4}-\d{4}\s+\w+\s+Graduate Manual', stripped):
            continue
            
        # Skip contact info patterns (phone, email, hall)
        if re.match(r'^Phone:\s*\d+-\d+-\d+', stripped):
            continue
        if re.match(r'^E-mail:\s*\S+@\S+', stripped):
            continue
        if re.match(r'^\d+\s+\w+\s+Hall', stripped):
            continue
            
        # Skip very short lines that look like headers/footers
        if len(stripped) < 3 and stripped.isdigit():
            continue
            
        cleaned_lines.append(line)
    
    # Remove excessive empty lines after header/footer removal
    temp_text = '\n'.join(cleaned_lines)
    temp_text = re.sub(r'\n{3,}', '\n\n', temp_text)
    cleaned_lines = temp_text.split('\n')
    
    # More aggressive line joining for paragraphs
    final_lines = []
    i = 0
    
    while i < len(cleaned_lines):
        current_line = cleaned_lines[i].strip()
        
        # Skip empty lines
        if not current_line:
            final_lines.append('')
            i += 1
            continue
        
        # Start building a paragraph
        paragraph = current_line
        j = i + 1
        
        # Keep joining lines until we hit a natural break
        while j < len(cleaned_lines):
            next_line = cleaned_lines[j].strip()
            
            # Stop if we hit an empty line (paragraph break)
            if not next_line:
                break
                
            # Stop if next line starts a new numbered section
            if re.match(r'^\d+\.', next_line):
                break
                
            # Stop if next line is a header/title (short and ends with specific patterns)
            if (len(next_line) < 50 and 
                (next_line.isupper() or 
                 next_line.endswith(('PROGRAM', 'MANUAL', 'PROCEDURES', 'POLICIES')))):
                break
            
            # Join the line
            paragraph += ' ' + next_line
            j += 1
        
        final_lines.append(paragraph)
        i = j
    
    # Clean up multiple consecutive newlines again after processing
    result = '\n'.join(final_lines)
    result = re.sub(r'\n{3,}', '\n\n', result)
    
    return result

def convert_pdf_to_markdown(pdf_path: str, output_path: str = None) -> str:
    """
    Convert a PDF file to markdown format.
    
    Args:
        pdf_path: Path to the input PDF file
        output_path: Optional path for output markdown file
        
    Returns:
        The markdown content as a string
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    
    if not pdf_path.lower().endswith('.pdf'):
        raise ValueError("Input file must be a PDF")
    
    # Initialize MarkItDown
    md = MarkItDown()
    
    # Convert PDF to markdown
    result = md.convert(pdf_path)
    markdown_content = result.text_content
    
    # Clean up the markdown text
    cleaned_content = clean_markdown_text(markdown_content)
    
    # Save to file if output path is specified
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(cleaned_content)
        print(f"Markdown saved to: {output_path}")
    
    return cleaned_content

def main():
    """Command line interface for PDF to markdown conversion."""
    if len(sys.argv) < 2:
        print("Usage: python pdf_to_markdown.py <pdf_file> [output_file]")
        print("Example: python pdf_to_markdown.py document.pdf document.md")
        sys.exit(1)
    
    pdf_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    # Generate default output filename if not provided
    if not output_file:
        pdf_path = Path(pdf_file)
        output_file = pdf_path.with_suffix('.md')
    
    try:
        markdown_content = convert_pdf_to_markdown(pdf_file, output_file)
        print(f"Successfully converted {pdf_file} to markdown")
        
        # Show preview of content (first 500 characters)
        print("\nPreview:")
        print("-" * 50)
        print(markdown_content[:500])
        if len(markdown_content) > 500:
            print("...")
            
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()