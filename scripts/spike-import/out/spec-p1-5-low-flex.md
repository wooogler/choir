# Shared MIME-info Database

X Desktop Group (http://www.freedesktop.org)  
Thomas Leonard  
tal197 at users.sf.net

## 1. Introduction

### 1.1. Version

This is version 0.21 of the Shared MIME-info Database specification, last updated 2 October 2018.

### 1.2. What is this spec?

Many programs and desktops use the MIME system[MIME] to represent the types of files. Frequently, it is necessary to work out the correct MIME type for a file. This is generally done by examining the file’s name or contents, and looking up the correct MIME type in a database.

It is also useful to store information about each type, such as a textual description of it, or a list of applications that can be used to view or edit files of that type.

For interoperability, it is useful for different programs to use the same database so that different programs agree on the type of a file and information is not duplicated. It is also helpful for application authors to only have to install new information in one place.

This specification attempts to unify the MIME database systems currently in use by GNOME[GNOME], KDE[KDE] and ROX[ROX], and provide room for future extensibility.

The MIME database does NOT store user preferences (such as a user’s preferred application for handling files of a particular type). It may be used to store static information, such as that files of a certain type may be viewed with a particular application.

### 1.3. Language used in this specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119[RFC-2119].

## 2. Unified system

In discussions about the previous systems used by GNOME, KDE and ROX (see the "History and related systems" document), it was clear that the differences between the databases were simply a result of them being separate, and not due to any fundamental disagreements between developers. Everyone is keen to see them merged.

This specification proposes:

- A standard way for applications to install new MIME related information.
- A standard way of getting the MIME type for a file.
- A standard way of getting information about a MIME type.
- Standard locations for all the files, and methods of resolving conflicts.

Further, the existing databases have been merged into a single package [SharedMIME].

### 2.1. Directory layout

There are two important requirements for the way the MIME database is stored:

- Applications must be able to extend the database in any way when they are installed, to add both new rules for determining type, and new information about specific types.
- It must be possible to install applications in /usr, /usr/local and the user’s home directory (in the normal Unix way) and have the MIME information used.

This specification uses the XDG Base Directory Specification[BaseDir] to define the prefixes below which the database is stored. In the rest of this document, paths shown with the prefix `<MIME>` indicate the files should be loaded from the mime subdirectory of every directory in `XDG_DATA_HOME:XDG_DATA_DIRS`.

For example, when using the default paths, “Load all the `<MIME>/text/html.xml` files” means to load `/usr/share/mime/text/html.xml`, `/usr/local/share/mime/text/html.xml`, and `~/.local/share/mime/text/html.xml` (if they exist, and in this order). Information found in a

Each application that wishes to contribute to the MIME database will install a single XML file, named after the application, into one of the three `<MIME>/packages/` directories (depending on where the user requested the application be installed). After installing, uninstalling or modifying this file, the application MUST run the update-mime-database command, which is provided by the freedesktop.org shared database[SharedMIME].

update-mime-database is passed the mime directory containing the packages subdirectory which was modified as its only argument. It scans all the XML files in the packages subdirectory, combines the information in them, and creates a number of output files.

Where the information from these files is conflicting, information from directories lower in the list takes precedence. Any file named Override.xml takes precedence over all other files in the same packages directory. This can be used by tools which let the user edit the database to ensure that the user’s changes take effect.

The files created by update-mime-database are:

- `<MIME>/globs` (contains a mapping from names to MIME types) [deprecated for globs2]
- `<MIME>/globs2` (contains a mapping from names to MIME types and glob weight)
- `<MIME>/magic` (contains a mapping from file contents to MIME types)
- `<MIME>/subclasses` (contains a mapping from MIME types to types they inherit from)
- `<MIME>/aliases` (contains a mapping from aliases to MIME types)
- `<MIME>/icons` (contains a mapping from MIME types to icons)
- `<MIME>/generic-icons` (contains a mapping from MIME types to generic icons)
- `<MIME>/XMLnamespaces` (contains a mapping from XML (namespaceURI, localName) pairs to MIME types)
- `<MIME>/MEDIA/SUBTYPE.xml` (one file for each MIME type, giving details about the type, including comment, icon and generic-icon)
- `<MIME>/mime.cache` (contains the same information as the globs2, magic, subclasses, aliases, icons, generic-icons and XMLnamespaces files, in a binary, mmappable format)

The format of these generated files and the source files in packages are explained in the following sections. This step serves several purposes. First, it allows applications to quickly get the data they need without parsing all the source XML files (the base package alone is over 700K). Second, it allows the database to be used for other purposes (such as creating the /etc/mime.types file if desired). Third, it allows validation to be performed on the input data, and removes the need for other applications to carefully check the input for errors themselves.

### 2.2. The source XML files

Each application provides only a single XML source file, which is installed in the packages directory as described above. This file is an XML file whose document element is named mime-info and whose namespace URI is http://www.freedesktop.org/standards/shared-mime-info. All elements described in this specification MUST have this namespace too.

The document element may contain zero or more mime-type child nodes, in any order, each describing a single MIME type. Each element has a type attribute giving the MIME type that it describes.

Each mime-type node may contain any combination of the following elements, and in any order:

- glob elements have a pattern attribute. Any file whose name matches this pattern will be given this MIME type (subject to conflicting rules in other files, of course). There is also an optional weight attribute which is used when resolving conflicts with other glob matches. The default weight value is 50, and the maximum is 100.

KDE’s glob system replaces GNOME’s and ROX’s ext/regex fields, since it is trivial to detect a pattern in the form ’*.ext’ and store it in an extension hash table internally. The full power of regular expressions was not being used by either desktop, and glob patterns are more suitable for filename matching anyway.

The first glob element represents the "main" extension for the file type. While this doesn’t affect the mimetype matching algorithm, this information can be useful when a single main extension is needed for a mimetype, for instance so that applications can choose an appropriate extension when saving a file.

- A glob-deleteall element, which indicates that patterns from previously parsed directories must be discarded. The patterns defined in this file (if any) are used instead.
- magic elements contain a list of match elements, any of which may match, and an optional priority attribute for all of the contained rules. Low numbers should be used for more generic types (such as ’gzip compressed data’) and higher values for specific subtypes (such as a word processor format that happens to use gzip to compress the file). The default priority value is 50, and the maximum is 100.

Each match element has a number of attributes:

| Attribute | Required? | Value |
| --- | --- | --- |
| type | Yes | string, host16, host32, big16, big32, little16, little32 or byte. |
| offset | Yes | The byte offset(s) in the file to check. This may be a single number or a range in the form ‘start:end’, indicating that all offsets in the range should be checked. The range is inclusive. |
| value | Yes | The value to compare the file contents with, in the format indicated by the type attribute. The string type supports the C character escapes (\0, \t, \n, \r, \xAB for hex, \777 for octal). |
| mask | No | The number to AND the value in the file with before comparing it to ‘value’. Masks for numerical types can be any number, while masks for strings must be in base 16, and start with 0x. |

Each element corresponds to one line of file(1)’s magic.mime file. They can be nested in the same way to provide the equivalent of continuation lines. That is, `<a><b/><c/></a>` means ’a and (b or c)’.

- A magic-deleteall element, which indicates that magic matches from previously parsed directories must be discarded. The magic defined in this file (if any) is used instead.
- alias elements indicate that the type is also sometimes known by another name, given by the type attribute. For example, audio/midi has an alias of audio/x-midi. Note that there should not be a mime-type element defining each alias; a single element defines the canonical name for the type and lists all its aliases.
- sub-class-of elements indicate that any data of this type is also some other type, given by the type attribute. See Section 2.11.
- comment elements give a human-readable textual description of the MIME type, usually composed of an acronym of the file name extension and a short description, like "ODS spreadsheet". There may be many of these elements with different xml:lang attributes to provide the text in multiple languages.
- acronym elements give experienced users a terse idea of the document contents. for example "ODS", "GEDCOM", "JPEG" and "XML".
- expanded-acronym elements are the expanded versions of the acronym elements, for example "OpenDocument Spreadsheet", "GEnealogical Data COMmunication", and "eXtensible Markup Language". The purpose of these elements is to provide users a way to look up information on various MIME types or file formats in third-party resources.
- icon elements specify the icon to be used for this particular mime-type, given by the name attribute. Generally the icon used for a mimetype is created based on the mime-type by mapping "/" characters to "-", but users can override this by using the icon element to customize the icon for a particular