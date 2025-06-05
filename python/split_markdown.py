#!/usr/bin/env python3
import re
import os
import argparse
from pathlib import Path

def clean_filename(text):
    """Clean text to create valid filename"""
    # Remove markdown formatting and special characters
    clean = re.sub(r'[#*`\[\]()]', '', text)
    # Replace spaces and special chars with hyphens
    clean = re.sub(r'[\s\-\–\—\(\)\{\}\[\]/\\:;"\'<>,.?!]+', '-', clean)
    # Remove leading/trailing hyphens and convert to lowercase
    clean = clean.strip('-').lower()
    # Remove multiple consecutive hyphens
    clean = re.sub(r'-+', '-', clean)
    return clean

def split_markdown_by_sections(input_file, output_dir="sections", create_index=False):
    """
    Split markdown file by main sections (# headers)
    """
    
    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found!")
        return False
    
    # Create output directory
    Path(output_dir).mkdir(exist_ok=True)
    
    # Read the file
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Split by main headers (# but not ##, ###, etc.)
    sections = re.split(r'\n(?=# [^#])', content)
    
    created_files = []
    
    # Handle the first part (before first main header)
    if not sections[0].startswith('# '):
        intro_content = sections.pop(0)
        # Save introduction
        intro_filename = os.path.join(output_dir, "00-introduction.md")
        with open(intro_filename, 'w', encoding='utf-8') as f:
            f.write(intro_content.strip())
        print(f"Created: {intro_filename}")
        created_files.append(("00-introduction.md", "Introduction"))
    
    # Process each section
    for i, section in enumerate(sections, 1):
        if not section.strip():
            continue
            
        # Extract section title from first line
        lines = section.strip().split('\n')
        if not lines:
            continue
            
        first_line = lines[0]
        if first_line.startswith('# '):
            # Extract title (remove # and any {#id} at the end)
            title = re.sub(r'\s*\{#.*?\}\s*$', '', first_line[2:]).strip()
            # Remove markdown formatting from title
            clean_title_for_filename = clean_filename(title)
            clean_title_for_display = re.sub(r'[*_`]', '', title)
            
            # Create filename with number prefix
            filename_safe = f"{i:02d}-{clean_title_for_filename}.md"
            filepath = os.path.join(output_dir, filename_safe)
            
            # Write section to file
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(section.strip())
            
            print(f"Created: {filepath} (Title: {clean_title_for_display})")
            created_files.append((filename_safe, clean_title_for_display))
        else:
            print(f"Warning: Section {i} doesn't start with proper header: {first_line[:50]}...")
    
    # Create index file if requested
    if create_index:
        index_file = os.path.join(output_dir, "README.md")
        with open(index_file, 'w', encoding='utf-8') as f:
            f.write(f"# {Path(input_file).stem} - Sections\n\n")
            f.write("This directory contains the sections split from the original markdown file.\n\n")
            f.write("## Table of Contents\n\n")
            
            for filename, title in created_files:
                f.write(f"- [{title}]({filename})\n")
        
        print(f"Created index: {index_file}")
    
    print(f"\nSplit complete! Created {len(created_files)} section files in '{output_dir}' directory.")
    return True

def main():
    parser = argparse.ArgumentParser(
        description='Split a markdown file into separate files based on main sections (# headers)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s document.md                           # Split into 'sections/' directory
  %(prog)s document.md -o my_sections            # Split into 'my_sections/' directory
  %(prog)s document.md -o parts --index          # Split into 'parts/' with index file
  %(prog)s handbook.md -o chapters -i            # Split with short option for index
        """
    )
    
    parser.add_argument('input_file', 
                        help='Input markdown file to split')
    
    parser.add_argument('-o', '--output-dir', 
                        default='sections',
                        help='Output directory for section files (default: sections)')
    
    parser.add_argument('-i', '--index', 
                        action='store_true',
                        help='Create an index README.md file in the output directory')
    
    parser.add_argument('-v', '--verbose', 
                        action='store_true',
                        help='Show detailed output')
    
    args = parser.parse_args()
    
    print(f"Splitting '{args.input_file}' into sections...")
    success = split_markdown_by_sections(
        args.input_file, 
        args.output_dir, 
        args.index
    )
    
    if not success:
        import sys
        sys.exit(1)

if __name__ == "__main__":
    main()